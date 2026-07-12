/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        base: 'var(--bg-base)',
        surface: 'var(--bg-surface)',
        'surface-2': 'var(--bg-surface-2)',
        'surface-3': 'var(--bg-surface-3)',
        accent: {
          DEFAULT: 'var(--accent)',
          hover: 'var(--accent-hover)',
          muted: 'var(--accent-muted)',
          subtle: 'var(--accent-subtle)',
          focus: 'var(--accent-focus)',
        },
        gain: {
          DEFAULT: 'var(--gain)',
          bg: 'var(--gain-bg)',
        },
        loss: {
          DEFAULT: 'var(--loss)',
          bg: 'var(--loss-bg)',
        },
        border: {
          DEFAULT: 'var(--border)',
          hover: 'var(--border-hover)',
          focus: 'var(--border-focus)',
        },
        input: {
          bg: 'var(--input-bg)',
          border: 'var(--input-border)',
        },
      },
      textColor: {
        primary: 'var(--text-primary)',
        secondary: 'var(--text-secondary)',
        tertiary: 'var(--text-tertiary)',
        inverse: 'var(--text-inverse)',
        accent: 'var(--accent)',
      },
      fontFamily: {
        sans: ['"Atkinson Hyperlegible"', '-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'system-ui', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'Consolas', '"Courier New"', 'monospace'],
      },
      fontSize: {
        'display-mega': ['36px', { lineHeight: '1.18', fontWeight: '650' }],
        'display-lg': ['28px', { lineHeight: '1.25', fontWeight: '650' }],
        'display-md': ['22px', { lineHeight: '1.3', fontWeight: '650' }],
        'display-sm': ['18px', { lineHeight: '1.35', fontWeight: '600' }],
        'title-md': ['17px', { lineHeight: '1.35', fontWeight: '650' }],
        'title-sm': ['16px', { lineHeight: '1.35', fontWeight: '650' }],
        'body-md': ['16px', { lineHeight: '1.45', fontWeight: '400' }],
        'body-sm': ['15px', { lineHeight: '1.45', fontWeight: '400' }],
        'caption': ['13px', { lineHeight: '1.45', fontWeight: '400' }],
        'caption-upper': ['13px', { lineHeight: '1.4', fontWeight: '650', letterSpacing: '0' }],
        'code': ['16px', { lineHeight: '1.4', fontWeight: '400' }],
        'button': ['14px', { lineHeight: '19px', fontWeight: '500' }],
      },
      borderRadius: {
        'none': '0px',
        'xs': '2px',
        'sm': '3px',
        DEFAULT: '4px',
        'md': '4px',
        'lg': '6px',
        'xl': '8px',
        'card': '0px',
        'btn': '4px',
        'pill': '9999px',
      },
      spacing: {
        'xxs': '2px',
        'xs': '4px',
        'sm-space': '6px',
      },
      boxShadow: {
        'none': 'none',
        'subtle': '0 1px 3px rgba(0, 0, 0, 0.3)',
        'float': '0 4px 12px rgba(0, 0, 0, 0.4)',
      },
    },
  },
  plugins: [],
}
