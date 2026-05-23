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
        sans: ['-apple-system', 'BlinkMacSystemFont', '"Segoe WPC"', '"Segoe UI"', 'system-ui', 'Ubuntu', '"Droid Sans"', 'sans-serif'],
        mono: ['Consolas', '"Courier New"', 'monospace'],
      },
      fontSize: {
        'display-mega': ['26px', { lineHeight: '1.3', fontWeight: '600' }],
        'display-lg': ['20px', { lineHeight: '1.35', fontWeight: '600' }],
        'display-md': ['16px', { lineHeight: '1.4', fontWeight: '600' }],
        'display-sm': ['14px', { lineHeight: '1.4', fontWeight: '600' }],
        'title-md': ['13px', { lineHeight: '1.4', fontWeight: '600' }],
        'title-sm': ['12px', { lineHeight: '1.4', fontWeight: '600' }],
        'body-md': ['13px', { lineHeight: '1.4', fontWeight: '400' }],
        'body-sm': ['12px', { lineHeight: '1.4', fontWeight: '400' }],
        'caption': ['11px', { lineHeight: '1.4', fontWeight: '400' }],
        'caption-upper': ['11px', { lineHeight: '1.4', fontWeight: '600', letterSpacing: '0.4px' }],
        'code': ['14px', { lineHeight: '1.35', fontWeight: '400' }],
        'button': ['12px', { lineHeight: '16px', fontWeight: '400' }],
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
