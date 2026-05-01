/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        mono: ['JetBrains Mono', 'monospace'],
        sans: ['Space Grotesk', 'sans-serif'],
      },
      colors: {
        bg: '#0a0c10',
        surface: '#111318',
        border: '#1e2230',
        accent: '#00d4ff',
        danger: '#ff3366',
        warn: '#ff8c00',
        ok: '#00e676',
        muted: '#4a5568',
      },
      animation: {
        pulse_slow: 'pulse 3s ease-in-out infinite',
        slide_in: 'slideIn 0.3s ease-out',
      },
      keyframes: {
        slideIn: {
          '0%': { opacity: '0', transform: 'translateY(-8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
    },
  },
  plugins: [],
};
