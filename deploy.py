#!/usr/bin/env python3
"""
IMS Deployment Manager
─────────────────────
Commands:
  deploy   — Start/stop containers (no tests, no health checks)
  test     — Run tests (backend unit tests OR outage simulation, never mixed)
  logs     — View service logs
  status   — Show container status
"""

import os
import sys
import subprocess
import argparse
import json
import time
from pathlib import Path
from typing import Optional, Dict
from dataclasses import dataclass
from enum import Enum


# ─── Enums & Data ────────────────────────────────────────────────────────────

class Environment(Enum):
    DEVELOPMENT = "development"
    STAGING     = "staging"
    PRODUCTION  = "production"


@dataclass
class Config:
    environment: Environment
    project_root: Path
    env_file: Optional[Path]
    verbose: bool = False


# ─── Colors & Logger ─────────────────────────────────────────────────────────

class C:
    BLUE   = '\033[94m'
    CYAN   = '\033[96m'
    GREEN  = '\033[92m'
    YELLOW = '\033[93m'
    RED    = '\033[91m'
    BOLD   = '\033[1m'
    DIM    = '\033[2m'
    END    = '\033[0m'


class Logger:
    def __init__(self, verbose: bool = False):
        self.verbose = verbose

    def info(self, msg: str):
        print(f"  {C.CYAN}→{C.END}  {msg}")

    def success(self, msg: str):
        print(f"  {C.GREEN}✓{C.END}  {msg}")

    def warning(self, msg: str):
        print(f"  {C.YELLOW}⚠{C.END}  {msg}")

    def error(self, msg: str):
        print(f"  {C.RED}✗{C.END}  {msg}")

    def debug(self, msg: str):
        if self.verbose:
            print(f"  {C.DIM}[debug] {msg}{C.END}")

    def banner(self, title: str, subtitle: str = ""):
        width = 60
        print()
        print(f"{C.BOLD}{C.BLUE}{'─' * width}{C.END}")
        print(f"{C.BOLD}{C.BLUE}  {title}{C.END}")
        if subtitle:
            print(f"{C.DIM}  {subtitle}{C.END}")
        print(f"{C.BOLD}{C.BLUE}{'─' * width}{C.END}")
        print()

    def section(self, title: str):
        print(f"\n  {C.BOLD}{title}{C.END}")
        print(f"  {C.DIM}{'·' * 40}{C.END}")

    def blank(self):
        print()


# ─── Shell Executor ───────────────────────────────────────────────────────────

class Shell:
    def __init__(self, logger: Logger, project_root: Path):
        self.logger = logger
        self.root   = project_root
        self.env    = {**os.environ, "PROJECT_ROOT": str(project_root)}

    def run(self, cmd: str, cwd: Optional[Path] = None) -> int:
        """Run command, stream output, return exit code."""
        cwd = cwd or self.root
        self.logger.debug(f"$ {cmd}  (cwd={cwd})")
        result = subprocess.run(cmd, shell=True, cwd=cwd, env=self.env)
        return result.returncode

    def output(self, cmd: str, cwd: Optional[Path] = None) -> str:
        """Run command silently, return stdout."""
        cwd = cwd or self.root
        result = subprocess.run(
            cmd, shell=True, cwd=cwd, env=self.env,
            capture_output=True, text=True
        )
        return result.stdout.strip()


# ─── Deploy ───────────────────────────────────────────────────────────────────

class Deployer:
    """Pure container lifecycle — no tests, no health checks."""

    def __init__(self, shell: Shell, logger: Logger):
        self.shell  = shell
        self.logger = logger

    def _compose_cmd(self, base: str, env_file: Optional[Path] = None) -> str:
        if env_file and env_file.exists():
            return f"docker-compose --env-file {env_file} {base}"
        return f"docker-compose {base}"

    def up(self, env_file: Optional[Path] = None):
        self.logger.section("Starting containers")
        cmd = self._compose_cmd("up -d --build", env_file)
        code = self.shell.run(cmd)
        if code == 0:
            self.logger.success("Containers are up")
        else:
            self.logger.error("docker-compose up failed")
            sys.exit(code)

    def down(self, remove_volumes: bool = False):
        self.logger.section("Stopping containers")
        flags = "-v" if remove_volumes else ""
        code  = self.shell.run(f"docker-compose down {flags}".strip())
        if code == 0:
            self.logger.success("Containers stopped")
        else:
            self.logger.error("docker-compose down failed")
            sys.exit(code)

    def stop(self, service: Optional[str] = None):
        """Pause containers without removing them. Use 'up' to bring them back."""
        if service:
            self.logger.section(f"Stopping container — {service}")
            cmd = f"docker-compose stop {service}"
        else:
            self.logger.section("Stopping all containers (keeping them intact)")
            cmd = "docker-compose stop"
        code = self.shell.run(cmd)
        if code == 0:
            tip = f"  {C.DIM}Run  deploy up  to start them again{C.END}"
            self.logger.success("Containers stopped  (data & volumes preserved)")
            print(tip)
        else:
            self.logger.error("docker-compose stop failed")
            sys.exit(code)

    def restart(self, env_file: Optional[Path] = None):
        self.down()
        self.logger.info("Waiting 2 s before restart...")
        time.sleep(2)
        self.up(env_file)

    def status(self):
        self.logger.section("Container status")
        raw = self.shell.output("docker-compose ps --format json")
        if not raw:
            self.logger.warning("No containers found (or docker-compose not running)")
            return

        try:
            # docker-compose v2 may return one JSON object per line
            lines = [l for l in raw.splitlines() if l.strip()]
            containers = [json.loads(l) for l in lines] if len(lines) > 1 else json.loads(raw)
            if isinstance(containers, dict):
                containers = [containers]

            for c in containers:
                name  = c.get("Service") or c.get("Name", "?")
                state = c.get("State") or c.get("Status", "?")
                color = C.GREEN if "running" in state.lower() or "up" in state.lower() else C.RED
                print(f"    {color}●{C.END}  {name:<20} {state}")
        except (json.JSONDecodeError, KeyError):
            # Fallback: plain text output
            self.shell.run("docker-compose ps")


# ─── Tests ────────────────────────────────────────────────────────────────────

class Tester:
    """
    Two completely independent test modes:
      • backend  — npm test inside /backend
      • simulate — npx ts-node simulate-outage.ts with --burst or --both
    """

    def __init__(self, shell: Shell, logger: Logger):
        self.shell  = shell
        self.logger = logger

    # ── Backend unit tests ────────────────────────────────────────────────────

    def backend(self) -> bool:
        self.logger.section("Backend unit tests")
        backend_dir = self.shell.root / "backend"

        if not backend_dir.exists():
            self.logger.error(f"Backend directory not found: {backend_dir}")
            return False

        code = self.shell.run("npm test", cwd=backend_dir)
        if code == 0:
            self.logger.success("All backend tests passed")
            return True
        else:
            self.logger.error(f"Backend tests failed (exit {code})")
            return False

    # ── Outage simulation ─────────────────────────────────────────────────────

    def simulate(self, mode: str = "burst", duration: int = 10) -> bool:
        """
        mode: 'burst' | 'both'
          --burst   single spike simulation
          --both    burst + baseline combined
        """
        if mode not in ("burst", "both"):
            self.logger.error(f"Unknown simulation mode '{mode}'. Use: burst | both")
            return False

        self.logger.section(f"Outage simulation — mode: {mode}, duration: {duration}s")
        scripts_dir = self.shell.root / "scripts"

        if not scripts_dir.exists():
            self.logger.error(f"Scripts directory not found: {scripts_dir}")
            return False

        cmd  = f"npx ts-node simulate-outage.ts --{mode} --duration {duration}"
        code = self.shell.run(cmd, cwd=scripts_dir)
        if code == 0:
            self.logger.success(f"Simulation ({mode}) completed")
            return True
        else:
            self.logger.error(f"Simulation failed (exit {code})")
            return False

    # ── Frontend build ────────────────────────────────────────────────────────

    def frontend_build(self) -> bool:
        self.logger.section("Frontend build check")
        frontend_dir = self.shell.root / "frontend"

        if not frontend_dir.exists():
            self.logger.error(f"Frontend directory not found: {frontend_dir}")
            return False

        code = self.shell.run("npm run build", cwd=frontend_dir)
        if code == 0:
            self.logger.success("Frontend build succeeded")
            return True
        else:
            self.logger.error(f"Frontend build failed (exit {code})")
            return False


# ─── Logs ─────────────────────────────────────────────────────────────────────

class LogViewer:
    def __init__(self, shell: Shell, logger: Logger):
        self.shell  = shell
        self.logger = logger

    def show(self, service: str = "backend", tail: int = 50, follow: bool = False):
        self.logger.section(f"Logs — {service}  (last {tail} lines)")
        flags = f"--tail {tail}"
        if follow:
            flags += " -f"
        code = self.shell.run(f"docker-compose logs {flags} {service}")
        if code != 0:
            self.logger.error("Could not retrieve logs. Is the service name correct?")

    def list_services(self):
        """Print known services from docker-compose."""
        self.logger.section("Available services")
        raw = self.shell.output("docker-compose config --services")
        if raw:
            for svc in raw.splitlines():
                print(f"    {C.CYAN}•{C.END}  {svc}")
        else:
            self.logger.warning("No services found — is docker-compose.yml present?")


# ─── Project root ─────────────────────────────────────────────────────────────

def find_project_root() -> Path:
    current = Path(__file__).resolve().parent
    while current != current.parent:
        if (current / "docker-compose.yml").exists() or (current / "docker-compose.yaml").exists():
            return current
        current = current.parent
    # Fallback: current working directory
    cwd = Path.cwd()
    if (cwd / "docker-compose.yml").exists() or (cwd / "docker-compose.yaml").exists():
        return cwd
    raise RuntimeError(
        "Could not find project root.\n"
        "  Make sure docker-compose.yml exists in this directory or a parent."
    )


# ─── CLI ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        prog="deploy",
        description="IMS Deployment Manager",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Commands
────────
  deploy up                   Start containers (dev environment)
  deploy up --env staging     Start containers for staging
  deploy up --env production  Start containers for production
  deploy stop                 Pause containers  (data kept, nothing removed)
  deploy stop --service api   Pause a single service only
  deploy down                 Remove containers  (data kept unless --volumes)
  deploy down --volumes       Remove containers AND wipe volumes
  deploy restart              Stop then start containers
  deploy status               Show container status

  test backend                Run backend unit tests
  test simulate               Run outage simulation (default: --burst)
  test simulate --mode both   Run burst + baseline simulation
  test simulate --duration 30 Custom duration in seconds
  test frontend               Run frontend build check

  logs                        Show backend logs (last 50 lines)
  logs --service frontend     Show logs for a specific service
  logs --tail 100             Show more lines
  logs --follow               Follow log output (Ctrl+C to stop)
  logs --list                 List all available services
        """,
    )

    parser.add_argument("-v", "--verbose", action="store_true", help="Verbose debug output")

    sub = parser.add_subparsers(dest="command")

    # ── deploy ──────────────────────────────────────────────────────────────
    dp = sub.add_parser("deploy", help="Container lifecycle (up / down / restart / status)")
    dp_sub = dp.add_subparsers(dest="deploy_action")

    up_p = dp_sub.add_parser("up", help="Start containers")
    up_p.add_argument(
        "--env",
        choices=["development", "staging", "production"],
        default="development",
        metavar="ENV",
        help="Environment: development | staging | production  (default: development)",
    )

    dn_p = dp_sub.add_parser("down", help="Stop containers")
    dn_p.add_argument("--volumes", action="store_true", help="Also remove volumes")

    st_p = dp_sub.add_parser("stop", help="Pause containers WITHOUT removing them  (data kept)")
    st_p.add_argument("--service", default=None, metavar="NAME", help="Stop a single service only")

    dp_sub.add_parser("restart", help="Stop then start containers")
    dp_sub.add_parser("status",  help="Show container status")

    # ── test ────────────────────────────────────────────────────────────────
    tp = sub.add_parser("test", help="Run tests (backend OR simulation — never mixed)")
    tp_sub = tp.add_subparsers(dest="test_action")

    tp_sub.add_parser("backend",  help="Run backend unit tests  (npm test)")
    tp_sub.add_parser("frontend", help="Run frontend build check (npm run build)")

    sim_p = tp_sub.add_parser("simulate", help="Run outage simulation")
    sim_p.add_argument(
        "--mode",
        choices=["burst", "both"],
        default="burst",
        help="Simulation mode: burst (single spike) | both (burst + baseline)  (default: burst)",
    )
    sim_p.add_argument(
        "--duration",
        type=int,
        default=10,
        metavar="SECONDS",
        help="Duration in seconds  (default: 10)",
    )

    # ── logs ────────────────────────────────────────────────────────────────
    lp = sub.add_parser("logs", help="View service logs")
    lp.add_argument("--service", default="backend", metavar="NAME", help="Service name  (default: backend)")
    lp.add_argument("--tail",    type=int, default=50, metavar="N",    help="Number of lines  (default: 50)")
    lp.add_argument("--follow",  action="store_true",                   help="Follow log output live")
    lp.add_argument("--list",    action="store_true",                   help="List all available services")

    # ────────────────────────────────────────────────────────────────────────
    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        return 0

    # Resolve project root
    try:
        root = find_project_root()
    except RuntimeError as e:
        print(f"\n  {C.RED}✗{C.END}  {e}\n")
        return 1

    log   = Logger(verbose=args.verbose)
    shell = Shell(log, root)

    # ── deploy ──────────────────────────────────────────────────────────────
    if args.command == "deploy":
        action = getattr(args, "deploy_action", None)
        if not action:
            dp.print_help()
            return 0

        deployer = Deployer(shell, log)

        if action == "up":
            env      = Environment(args.env)
            env_file = root / f".env.{env.value}"
            log.banner(
                f"IMS Deploy — {env.value.upper()}",
                f"Project: {root}",
            )
            deployer.up(env_file=env_file if env_file.exists() else None)

        elif action == "stop":
            svc = getattr(args, "service", None)
            log.banner(
                f"IMS Deploy — Stop{f' ({svc})' if svc else ''}",
                "Containers paused — data & volumes untouched",
            )
            deployer.stop(service=svc)

        elif action == "down":
            log.banner("IMS Deploy — Stopping containers")
            deployer.down(remove_volumes=args.volumes)

        elif action == "restart":
            log.banner("IMS Deploy — Restart")
            env_file = root / ".env.development"
            deployer.restart(env_file=env_file if env_file.exists() else None)

        elif action == "status":
            log.banner("IMS — Container Status")
            deployer.status()

    # ── test ────────────────────────────────────────────────────────────────
    elif args.command == "test":
        action = getattr(args, "test_action", None)
        if not action:
            tp.print_help()
            return 0

        tester = Tester(shell, log)

        if action == "backend":
            log.banner("IMS Tests — Backend Unit Tests")
            ok = tester.backend()
            return 0 if ok else 1

        elif action == "frontend":
            log.banner("IMS Tests — Frontend Build Check")
            ok = tester.frontend_build()
            return 0 if ok else 1

        elif action == "simulate":
            log.banner(
                f"IMS Tests — Outage Simulation",
                f"Mode: {args.mode}   Duration: {args.duration}s",
            )
            ok = tester.simulate(mode=args.mode, duration=args.duration)
            return 0 if ok else 1

    # ── logs ────────────────────────────────────────────────────────────────
    elif args.command == "logs":
        viewer = LogViewer(shell, log)
        if args.list:
            log.banner("IMS — Service List")
            viewer.list_services()
        else:
            log.banner(
                f"IMS Logs — {args.service}",
                "Press Ctrl+C to stop" if args.follow else f"Showing last {args.tail} lines",
            )
            viewer.show(service=args.service, tail=args.tail, follow=args.follow)

    return 0


if __name__ == "__main__":
    sys.exit(main())