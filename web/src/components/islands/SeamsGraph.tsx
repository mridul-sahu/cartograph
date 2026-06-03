// Interactive dependency graph for the tracked repos + their external
// satellites. Renders with React Flow inside an Astro client island.
//
// Visual contract:
// - Brutalist node chrome: 2px ink border, 6px block shadow, hard rectangles,
//   JetBrains Mono labels, no rounded corners.
// - JAX hub node gets the cobalt accent.
// - Tracked repos (jax/xla/orbax/tunix/tokamax) are clickable and route to
//   `/repo/<repo>/`; external nodes are inert.
// - Hovering a node highlights its outgoing edges in the accent color.
// - All animations gated on `prefers-reduced-motion`.
import { useMemo, useState, useCallback } from 'react';
import { REPOS } from '~/lib/repos';
import ReactFlow, {
  Background,
  Controls,
  Handle,
  Position,
  type Node,
  type Edge,
  type NodeProps,
  type EdgeProps,
  BaseEdge,
  EdgeLabelRenderer,
  getStraightPath,
} from 'reactflow';
import 'reactflow/dist/style.css';

type RepoKind = 'tracked' | 'external';

interface NodeData {
  label: string;
  kind: RepoKind;
  href?: string;
  isHub?: boolean;
  hovered?: boolean;
  hoveredOutgoing?: boolean;
}

const TRACKED = new Set<string>(REPOS);

// Custom node: brutalist rect with optional accent fill.
function RepoNode({ data }: NodeProps<NodeData>) {
  const accent = data.isHub;
  const tracked = data.kind === 'tracked';
  const hovered = data.hovered;

  const base = accent
    ? { background: 'var(--accent)', color: 'var(--accent-fg)', borderColor: 'var(--border)' }
    : tracked
      ? { background: 'var(--bg)', color: 'var(--fg)', borderColor: 'var(--border)' }
      : { background: 'var(--muted-bg)', color: 'var(--muted)', borderColor: 'var(--muted)' };

  const shadow = hovered
    ? '8px 8px 0 0 var(--shadow)'
    : tracked
      ? '6px 6px 0 0 var(--shadow)'
      : '4px 4px 0 0 var(--shadow)';

  const handleStyle = { background: 'transparent', border: 'none', width: 1, height: 1 };

  const content = (
    <div
      style={{
        background: base.background,
        color: base.color,
        border: `2px solid ${base.borderColor}`,
        boxShadow: shadow,
        padding: tracked ? '0.55rem 1.1rem' : '0.4rem 0.85rem',
        fontFamily: '"JetBrains Mono", ui-monospace, monospace',
        fontSize: tracked ? '0.95rem' : '0.78rem',
        fontWeight: tracked ? 700 : 500,
        textTransform: 'lowercase',
        letterSpacing: '-0.01em',
        whiteSpace: 'nowrap',
        userSelect: 'none',
        cursor: tracked && data.href ? 'pointer' : 'default',
        transition: 'transform 120ms ease-out, box-shadow 120ms ease-out',
        transform: hovered ? 'translate(-1px, -1px)' : 'none',
      }}
    >
      {data.label}
    </div>
  );

  return (
    <>
      <Handle type="target" position={Position.Top} style={handleStyle} />
      <Handle type="target" position={Position.Left} style={handleStyle} />
      {tracked && data.href ? (
        <a href={data.href} style={{ textDecoration: 'none' }} aria-label={`open ${data.label}`}>
          {content}
        </a>
      ) : (
        content
      )}
      <Handle type="source" position={Position.Right} style={handleStyle} />
      <Handle type="source" position={Position.Bottom} style={handleStyle} />
    </>
  );
}

// Custom edge: straight line + arrow, swaps colour when source node is hovered.
function FlowEdge({ id, sourceX, sourceY, targetX, targetY, markerEnd, data, style }: EdgeProps) {
  const [edgePath] = getStraightPath({ sourceX, sourceY, targetX, targetY });
  const highlighted = Boolean((data as { highlighted?: boolean } | undefined)?.highlighted);
  return (
    <BaseEdge
      id={id}
      path={edgePath}
      markerEnd={markerEnd}
      style={{
        ...style,
        stroke: highlighted ? 'var(--accent)' : 'var(--border)',
        strokeWidth: highlighted ? 2.4 : 1.6,
        transition: 'stroke 140ms ease-out, stroke-width 140ms ease-out',
      }}
    />
  );
}

const nodeTypes = { repo: RepoNode };
const edgeTypes = { flow: FlowEdge };

// Static layout — positions chosen by hand so the JAX hub sits dead-centre.
const RAW_NODES: { id: string; label: string; kind: RepoKind; pos: [number, number]; href?: string; isHub?: boolean }[] = [
  { id: 'jax', label: 'jax', kind: 'tracked', pos: [400, 220], href: '/repo/jax/', isHub: true },
  { id: 'xla', label: 'xla', kind: 'tracked', pos: [720, 220], href: '/repo/xla/' },
  { id: 'orbax', label: 'orbax', kind: 'tracked', pos: [400, 60], href: '/repo/orbax/' },
  { id: 'tunix', label: 'tunix', kind: 'tracked', pos: [120, 80], href: '/repo/tunix/' },
  { id: 'tokamax', label: 'tokamax', kind: 'tracked', pos: [120, 360], href: '/repo/tokamax/' },
  // External satellites
  { id: 'jaxlib', label: 'jaxlib', kind: 'external', pos: [560, 360] },
  { id: 'triton', label: 'triton', kind: 'external', pos: [720, 360] },
  { id: 'libtpu', label: 'libtpu', kind: 'external', pos: [720, 60] },
  { id: 'qwix', label: 'qwix', kind: 'external', pos: [-60, 420] },
  { id: 'flax-nnx', label: 'flax-nnx', kind: 'external', pos: [-80, 160] },
  { id: 'optax', label: 'optax', kind: 'external', pos: [-80, 40] },
  { id: 'tensorstore', label: 'tensorstore', kind: 'external', pos: [560, -40] },
  { id: 'etils', label: 'etils', kind: 'external', pos: [380, -60] },
  { id: 'vllm', label: 'vllm', kind: 'external', pos: [200, 460] },
  { id: 'sglang-jax', label: 'sglang-jax', kind: 'external', pos: [380, 460] },
  { id: 'transformers', label: 'hf transformers', kind: 'external', pos: [0, 460] },
];

// Directed edges: src -> dst meaning "src depends on dst".
const RAW_EDGES: [string, string][] = [
  ['jax', 'xla'],
  ['jax', 'jaxlib'],
  ['jaxlib', 'libtpu'],
  ['jaxlib', 'triton'],
  ['orbax', 'jax'],
  ['orbax', 'tensorstore'],
  ['orbax', 'etils'],
  ['tunix', 'jax'],
  ['tunix', 'orbax'],
  ['tunix', 'optax'],
  ['tunix', 'flax-nnx'],
  ['tunix', 'qwix'],
  ['tunix', 'vllm'],
  ['tunix', 'sglang-jax'],
  ['tunix', 'transformers'],
  ['tokamax', 'jax'],
  ['tokamax', 'xla'],
  ['tokamax', 'qwix'],
];

export default function SeamsGraph() {
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const nodes: Node<NodeData>[] = useMemo(
    () =>
      RAW_NODES.map((n) => ({
        id: n.id,
        type: 'repo',
        position: { x: n.pos[0], y: n.pos[1] },
        data: {
          label: n.label,
          kind: n.kind,
          href: n.href,
          isHub: n.isHub,
          hovered: hoveredId === n.id,
        },
        draggable: false,
        connectable: false,
        selectable: false,
      })),
    [hoveredId]
  );

  const edges: Edge[] = useMemo(
    () =>
      RAW_EDGES.map(([src, dst]) => ({
        id: `${src}->${dst}`,
        source: src,
        target: dst,
        type: 'flow',
        data: { highlighted: hoveredId === src },
        markerEnd: {
          type: 'arrowclosed' as const,
          color: hoveredId === src ? 'var(--accent)' : 'var(--border)',
          width: 14,
          height: 14,
        },
      })),
    [hoveredId]
  );

  const onNodeMouseEnter = useCallback((_: unknown, n: Node) => setHoveredId(n.id), []);
  const onNodeMouseLeave = useCallback(() => setHoveredId(null), []);
  const onNodeClick = useCallback((_: unknown, n: Node) => {
    if (TRACKED.has(n.id)) window.location.href = `/repo/${n.id}/`;
  }, []);

  return (
    <div
      className="brutal-card"
      style={{
        height: 540,
        width: '100%',
        padding: 0,
        background: 'var(--bg)',
        position: 'relative',
      }}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodeMouseEnter={onNodeMouseEnter}
        onNodeMouseLeave={onNodeMouseLeave}
        onNodeClick={onNodeClick}
        fitView
        fitViewOptions={{ padding: 0.18 }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnDrag
        zoomOnScroll={false}
        zoomOnPinch
        proOptions={{ hideAttribution: true }}
        minZoom={0.4}
        maxZoom={1.6}
      >
        <Background gap={24} size={1} color="var(--muted)" style={{ opacity: 0.25 }} />
        <Controls
          showInteractive={false}
          style={{
            background: 'var(--bg)',
            border: '2px solid var(--border)',
            boxShadow: '4px 4px 0 0 var(--shadow)',
          }}
        />
      </ReactFlow>
      <div
        style={{
          position: 'absolute',
          left: 12,
          bottom: 12,
          background: 'var(--bg)',
          border: '2px solid var(--border)',
          boxShadow: '4px 4px 0 0 var(--shadow)',
          padding: '0.45rem 0.7rem',
          fontFamily: '"JetBrains Mono", ui-monospace, monospace',
          fontSize: '0.7rem',
          color: 'var(--muted)',
          textTransform: 'lowercase',
          letterSpacing: '0.05em',
          pointerEvents: 'none',
        }}
      >
        click a tracked repo · arrow = depends on
      </div>
    </div>
  );
}
