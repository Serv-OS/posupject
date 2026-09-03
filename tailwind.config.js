/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Theme-aware tokens (values live as CSS vars in index.css).
        // Channel form keeps /opacity modifiers working (e.g. bg-ember/10).
        ink:          'rgb(var(--c-ink) / <alpha-value>)',
        'ink-soft':   'var(--ink-soft)',
        'ink-line':   'var(--ink-line)',
        paper:        'rgb(var(--c-text) / <alpha-value>)',
        'paper-soft': 'rgb(var(--c-text-soft) / <alpha-value>)',
        // "ember" keeps its name but now resolves to Signal green (primary)
        ember:        'rgb(var(--c-primary) / <alpha-value>)',
        'ember-deep': 'rgb(var(--c-primary-deep) / <alpha-value>)',
        signal:       'rgb(var(--c-primary) / <alpha-value>)',
        uv:           'rgb(var(--c-uv) / <alpha-value>)',
        'uv-deep':    'rgb(var(--c-uv-deep) / <alpha-value>)',
        amber:        'rgb(var(--c-amber) / <alpha-value>)',
        'amber-deep': 'rgb(var(--c-amber-deep) / <alpha-value>)',
        coral:        'rgb(var(--c-coral) / <alpha-value>)',
        'coral-deep': 'rgb(var(--c-coral-deep) / <alpha-value>)',
        muted:        'rgb(var(--c-muted) / <alpha-value>)',
        dim:          'rgb(var(--c-dim) / <alpha-value>)',
        panel:        'var(--panel)',
        card:         'var(--card)',
        desk:         'var(--desk)',
        solid:        'var(--surface-solid)',
        bdr:          'var(--bdr)',
      },
      fontFamily: {
        sans:    ['Space Grotesk', '-apple-system', 'BlinkMacSystemFont', 'system-ui', 'sans-serif'],
        display: ['Syne', 'Space Grotesk', 'system-ui', 'sans-serif'],
        mono:    ['JetBrains Mono', 'SF Mono', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      borderRadius: {
        '2xl': '16px',
        '3xl': '24px',
      },
    },
  },
  plugins: [],
};
