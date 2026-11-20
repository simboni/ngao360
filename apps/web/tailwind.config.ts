import type { Config } from 'tailwindcss';

/**
 * Tailwind theme mapped to the NGAO360 design tokens (blueprint 12.1/12.2),
 * which are defined as CSS variables in src/app/globals.css.
 */
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        navy: 'rgb(var(--ngao-navy) / <alpha-value>)',
        'deep-blue': 'rgb(var(--ngao-deep-blue) / <alpha-value>)',
        teal: 'rgb(var(--ngao-teal) / <alpha-value>)',
        gold: 'rgb(var(--ngao-gold) / <alpha-value>)',
        cloud: 'rgb(var(--ngao-cloud) / <alpha-value>)',
        surface: 'rgb(var(--ngao-white) / <alpha-value>)',
        slate: 'rgb(var(--ngao-slate) / <alpha-value>)',
        error: 'rgb(var(--ngao-error) / <alpha-value>)',
        success: 'rgb(var(--ngao-success) / <alpha-value>)',
        ink: 'rgb(var(--ngao-ink) / <alpha-value>)',
        line: 'rgb(var(--ngao-line) / <alpha-value>)',
      },
      fontFamily: {
        sans: ['"Inter Variable"', 'Inter', 'Aptos', 'system-ui', 'sans-serif'],
      },
      fontSize: {
        meta: ['12px', '16px'],
        body: ['14px', '20px'],
        card: ['15px', '22px'],
        section: ['18px', '26px'],
        page: ['26px', '32px'],
      },
      borderRadius: {
        card: '14px',
      },
      spacing: {
        sidebar: '248px',
        'sidebar-collapsed': '72px',
        topbar: '64px',
      },
      boxShadow: {
        card: '0 1px 2px rgb(16 43 70 / 0.06)',
      },
      height: { row: '48px' },
    },
  },
  plugins: [],
};

export default config;
