import { useEffect } from 'react';

// Walk the page after hydration and rehydrate every <pre data-mermaid> into
// an inline SVG. Re-runs on theme change so colours track.
export default function MermaidRehydrator() {
  useEffect(() => {
    let cancelled = false;

    async function render() {
      const nodes = Array.from(document.querySelectorAll<HTMLElement>('pre[data-mermaid]'));
      if (nodes.length === 0) return;

      const mermaid = (await import('mermaid')).default;
      const isDark = document.documentElement.dataset.theme === 'dark';
      mermaid.initialize({
        startOnLoad: false,
        theme: isDark ? 'dark' : 'neutral',
        themeVariables: {
          fontFamily: '"JetBrains Mono", ui-monospace, monospace',
          fontSize: '14px',
        },
        flowchart: { useMaxWidth: true, htmlLabels: true, curve: 'basis' },
        sequence: { useMaxWidth: true },
      });

      for (let i = 0; i < nodes.length; i++) {
        if (cancelled) return;
        const el = nodes[i];
        const source = el.textContent ?? '';
        const id = `m-${Date.now()}-${i}`;
        try {
          const { svg } = await mermaid.render(id, source);
          const wrapper = document.createElement('div');
          wrapper.className = 'mermaid';
          wrapper.innerHTML = svg;
          el.replaceWith(wrapper);
        } catch (err) {
          el.outerHTML = `<pre class="mermaid"><code>mermaid render error: ${String(err)}</code></pre>`;
        }
      }
    }

    render();

    const observer = new MutationObserver(() => {
      // Theme changed — re-render any cached diagrams. We do not re-render
      // already-converted ones (they keep their original colours until reload).
      if (document.querySelectorAll('pre[data-mermaid]').length > 0) render();
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, []);

  return null;
}
