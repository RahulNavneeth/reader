/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Atlassian-ish neutral palette
        ink: {
          900: '#091E42',
          800: '#172B4D',
          700: '#253858',
          600: '#42526E',
          500: '#6B778C',
          400: '#8993A4',
          300: '#A5ADBA',
          200: '#C1C7D0',
          100: '#DFE1E6',
          50:  '#EBECF0',
          25:  '#F4F5F7',
          0:   '#FAFBFC',
        },
        accent: {
          50:  '#DEEBFF',
          100: '#B3D4FF',
          400: '#4C9AFF',
          500: '#2684FF',
          600: '#0065FF',
          700: '#0052CC',
          800: '#0747A6',
        },
      },
      fontFamily: {
        sans: ['"Inter"', '-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      boxShadow: {
        // Decorative shadows neutralised — Reader uses a flat
        // style with borders for separation. `shadow-card` and
        // `shadow-raised` are still referenced by many components
        // (popovers, modals, scroll-to-top buttons); rather than
        // chase down every usage, redefine the tokens to `none`
        // so the existing markup loses the shadow without
        // touching every file. The 1 px borders already in place
        // do the elevation work on their own.
        card: 'none',
        raised: 'none',
      },
    },
  },
  plugins: [],
}
