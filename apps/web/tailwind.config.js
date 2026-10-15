/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        forge: {
          bg: '#07090D',
          panel: '#0D1118',
          surface: '#131923',
          border: '#232B38',
          text: '#F5F5F5',
          muted: '#A7B0BD',
          cyan: '#19D3F3',
          orange: '#FF8A24',
          lime: '#D7F542',
          purple: '#9B5CFF',
        },
      },
      fontFamily: {
        display: ['"Space Grotesk"', 'system-ui', 'sans-serif'],
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
    },
  },
  plugins: [],
};