// Interactive dependency graph for the tracked repos + their external
// satellites. Renders with React Flow inside an Astro client island.
//
// DATA-DRIVEN: nodes + edges come from `/api/seams-graph` at runtime, which
// derives them from the live tracked-repo list + guides/seams.md. The graph
// reflects whatever repos the running instance tracks — add a fork (and its
// seam sections) and it appears here on next load; nothing is hand-maintained.
//
// Visual contract:
// - Brutalist node chrome: 2px ink border, 6px block shadow, hard rectangles,
//   JetBrains Mono labels, no rounded corners.
// - The most-connected tracked repo (the hub) gets the cobalt accent.
// - Tracked repos are clickable and route to `/repo/<repo>/`; external nodes
//   are inert.
// - Hovering a node highlights its outgoing edges in the accent color.
import { useMemo, useState, useCallback, useEffect } from 'react';
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

// Shape returned by GET /api/seams-graph.
interface GraphNode {
  id: string;
  label: string;
  kind: RepoKind;
  href?: string;
  isHub?: boolean;
}
interface GraphPayload {
  nodes: GraphNode[];
  edges: [string, string][];
  hub: string | null;
}

// Deterministic radial layout computed from the node list — no hand-laid
// positions, so any repo set lays out sensibly. Hub dead-centre; other
// tracked repos on an inner ring; external satellites on an outer ring.
function layout(nodes: GraphNode[]): Record<string, [number, number]> {
  const pos: Record<string, [number, number]> = {};
  const hub = nodes.find((n) => n.isHub);
  const innerTracked = nodes.filter((n) => n.kind === 'tracked' && !n.isHub);
  const external = nodes.filter((n) => n.kind === 'external');
  if (hub) pos[hub.id] = [0, 0];
  const ring = (arr: GraphNode[], radius: number, phase: number) => {
    const n = Math.max(1, arr.length);
    arr.forEach((node, i) => {
      const a = phase + (2 * Math.PI * i) / n;
      pos[node.id] = [Math.round(radius * Math.cos(a)), Math.round(radius * Math.sin(a))];
    });
  };
  ring(innerTracked, 240, -Math.PI / 2);
  // Offset the outer ring by half a step so satellites sit between spokes.
  ring(external, 470, -Math.PI / 2 + Math.PI / Math.max(1, external.length));
  return pos;
}

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

type Fetched =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; data: GraphPayload };

export default function SeamsGraph() {
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [state, setState] = useState<Fetched>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    fetch('/api/seams-graph')
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d: GraphPayload) => {
        if (!cancelled) setState({ kind: 'ready', data: d });
      })
      .catch((e) => {
        if (!cancelled) setState({ kind: 'error', message: String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const graph = state.kind === 'ready' ? state.data : null;
  const positions = useMemo(() => (graph ? layout(graph.nodes) : {}), [graph]);

  const nodes: Node<NodeData>[] = useMemo(() => {
    if (!graph) return [];
    return graph.nodes.map((n) => {
      const [x, y] = positions[n.id] ?? [0, 0];
      return {
        id: n.id,
        type: 'repo',
        position: { x, y },
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
      };
    });
  }, [graph, positions, hoveredId]);

  const trackedIds = useMemo(
    () => new Set((graph?.nodes ?? []).filter((n) => n.kind === 'tracked').map((n) => n.id)),
    [graph]
  );

  const edges: Edge[] = useMemo(() => {
    if (!graph) return [];
    return graph.edges.map(([src, dst]) => ({
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
    }));
  }, [graph, hoveredId]);

  const onNodeMouseEnter = useCallback((_: unknown, n: Node) => setHoveredId(n.id), []);
  const onNodeMouseLeave = useCallback(() => setHoveredId(null), []);
  const onNodeClick = useCallback(
    (_: unknown, n: Node) => {
      if (trackedIds.has(n.id)) window.location.href = `/repo/${n.id}/`;
    },
    [trackedIds]
  );

  if (state.kind !== 'ready') {
    return (
      <div
        className="brutal-card"
        style={{ height: 540, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      >
        <div className="font-mono text-sm text-muted">
          {state.kind === 'loading'
            ? 'loading seam graph…'
            : `seam graph unavailable (${state.message}) — is the server running?`}
        </div>
      </div>
    );
  }
  if (nodes.length === 0) {
    return (
      <div
        className="brutal-card"
        style={{ height: 540, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      >
        <div className="font-mono text-sm text-muted">
          no tracked repos yet — add a fork with <code>scripts/fork-setup.sh</code>.
        </div>
      </div>
    );
  }

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
