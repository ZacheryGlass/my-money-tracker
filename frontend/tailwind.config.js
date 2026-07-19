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
        // Driven by the --font-ui appearance preference; falls back to the system stack.
        sans: ["var(--font-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif)"],
        mono: ['"IBM Plex Mono"', 'Consolas', '"Courier New"', 'monospace'],
      },
      fontSize: {
        // Each size scales with the --font-scale appearance preference (Default = 1).
        'display-mega': ['calc(36px * var(--font-scale, 1))', { lineHeight: '1.18', fontWeight: '650' }],
        'display-lg': ['calc(28px * var(--font-scale, 1))', { lineHeight: '1.25', fontWeight: '650' }],
        'display-md': ['calc(22px * var(--font-scale, 1))', { lineHeight: '1.3', fontWeight: '650' }],
        'display-sm': ['calc(18px * var(--font-scale, 1))', { lineHeight: '1.35', fontWeight: '600' }],
        'title-md': ['calc(17px * var(--font-scale, 1))', { lineHeight: '1.35', fontWeight: '650' }],
        'title-sm': ['calc(16px * var(--font-scale, 1))', { lineHeight: '1.35', fontWeight: '650' }],
        'body-md': ['calc(16px * var(--font-scale, 1))', { lineHeight: '1.45', fontWeight: '400' }],
        'body-sm': ['calc(15px * var(--font-scale, 1))', { lineHeight: '1.45', fontWeight: '400' }],
        'caption': ['calc(13px * var(--font-scale, 1))', { lineHeight: '1.45', fontWeight: '400' }],
        'caption-upper': ['calc(13px * var(--font-scale, 1))', { lineHeight: '1.4', fontWeight: '650', letterSpacing: '0' }],
        'code': ['calc(16px * var(--font-scale, 1))', { lineHeight: '1.4', fontWeight: '400' }],
        'button': ['calc(14px * var(--font-scale, 1))', { lineHeight: '19px', fontWeight: '500' }],
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
