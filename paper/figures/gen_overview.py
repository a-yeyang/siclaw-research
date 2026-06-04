#!/usr/bin/env python3
"""
Full-system architecture overview for the AAAI paper (Figure 1, full width).
Clean academic recreation of the project README diagram:
channels -> control plane (Portal / Gateway / Shared DB) -> AgentBox -> read-only targets.
Exports PDF (for LaTeX) + PNG (for inspection).
"""
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch

plt.rcParams.update({
    'font.family': 'serif',
    'font.serif': ['Times New Roman', 'Times', 'DejaVu Serif'],
    'figure.dpi': 300, 'savefig.dpi': 300,
    'savefig.bbox': 'tight', 'savefig.pad_inches': 0.02,
})

# Palette (clean, light academic)
C = {
    'chan':   ('#e9eefb', '#3856a8'),
    'cp':     ('#ffffff', '#3856a8'),
    'portal': ('#eef3ff', '#5b76c9'),
    'gw':     ('#eaf7ef', '#3a9b54'),
    'db':     ('#f4eefb', '#7e6bb0'),
    'abox':   ('#f7f9ff', '#cc4b3a'),
    'brain':  ('#e9eefb', '#3856a8'),
    'item':   ('#ffffff', '#7b8aa8'),
    'tgt':    ('#f0f1f5', '#5a6b8a'),
    'note':   ('#f6f7fa', '#9aa3b5'),
    'brain_e':('#e9eefb', '#3856a8'),
}
EDGE = '#33415c'
TXT  = '#1f2a44'
SUB  = '#5a6379'

fig, ax = plt.subplots(figsize=(7.1, 3.95))
ax.set_xlim(0, 190); ax.set_ylim(0, 100)
ax.set_aspect('equal'); ax.axis('off')

def box(x0, y0, x1, y1, fc, ec, lw=1.0, ls='-', z=2, rounding=1.6):
    p = FancyBboxPatch((x0, y0), x1 - x0, y1 - y0,
                       boxstyle=f"round,pad=0,rounding_size={rounding}",
                       fc=fc, ec=ec, lw=lw, ls=ls, zorder=z, mutation_aspect=1.0)
    ax.add_patch(p)

def txt(x, y, s, size=6.0, w='normal', c=TXT, ha='center', va='center', st='normal'):
    ax.text(x, y, s, fontsize=size, fontweight=w, color=c, ha=ha, va=va, style=st, zorder=6)

def arrow(x0, y0, x1, y1, c=EDGE, lw=1.1, ls='-', rad=0.0):
    ax.annotate('', xy=(x1, y1), xytext=(x0, y0),
                arrowprops=dict(arrowstyle='-|>', color=c, lw=lw, ls=ls,
                                shrinkA=1, shrinkB=1,
                                connectionstyle=f'arc3,rad={rad}'), zorder=4)

MAIN_L, MAIN_R = 5, 131          # main column extent
SIDE_L, SIDE_R = 136, 188        # right callouts

# ───────────────────────── Channels (top) ─────────────────────────
chan = [('CLI (TUI)', 24), ('Web UI', 58), ('Slack / Telegram / Lark', 92), ('Webhooks /\nScheduled Triggers', 122)]
cw = 26
for label, cx in chan:
    box(cx - cw/2, 90, cx + cw/2, 98, *C['chan'], lw=1.0)
    txt(cx, 94, label, 6.3, 'bold')
txt((MAIN_L+MAIN_R)/2, 99.6, 'User intent enters through multiple channels', 6.2, 'bold', '#3856a8')

# ──────────────────────── Control Plane ───────────────────────────
box(MAIN_L, 50, MAIN_R, 86, *C['cp'], lw=1.3)
txt(MAIN_L + 3, 84, 'CONTROL PLANE', 6.6, 'bold', '#3856a8', ha='left')

# Portal panel
box(8, 52, 86, 82, *C['portal'], lw=1.0)
txt(11, 79.5, 'Portal', 7.2, 'bold', ha='left')
txt(11, 76.3, 'curate agents, catalogs, auth, channels', 5.6, 'normal', SUB, ha='left', st='italic')
# Specialist agents strip
box(11, 67.5, 83, 74.5, '#ffffff', '#5b76c9', lw=0.8)
txt(47, 72.4, 'Specialist Agents (N)', 5.8, 'bold')
txt(47, 69.4, 'Workload Troubleshooter  $\\cdot$  Network Expert  $\\cdot$  Volcano Batch Specialist  $\\cdot$  $\\ldots$', 5.3, 'normal', TXT)
# Resource row
res = [('Skills', 'core / global / personal'), ('Knowledge', 'versioned md wiki'),
       ('MCP servers', ''), ('Credentials', 'clusters + SSH hosts')]
rx0, rx1 = 11, 83; rw = (rx1 - rx0) / 4
for i, (t, sub) in enumerate(res):
    cx0 = rx0 + i*rw + 1
    cx1 = rx0 + (i+1)*rw - 1
    box(cx0, 54, cx1, 65.5, *C['item'], lw=0.8)
    txt((cx0+cx1)/2, 61.5, t, 5.9, 'bold')
    if sub:
        txt((cx0+cx1)/2, 57.6, sub, 4.9, 'normal', SUB)

# Gateway panel
box(89, 52, 108, 82, *C['gw'], lw=1.0)
txt(98.5, 79.5, 'Gateway', 7.0, 'bold')
txt(98.5, 76.3, 'runtime orchestration', 5.2, 'normal', SUB, st='italic')
for i, it in enumerate(['Sessions', 'Spawner', 'WebSockets', 'Cron', 'Triggers']):
    txt(98.5, 72 - i*4.0, it, 5.6)

# Shared DB panel
box(111, 52, 129, 82, *C['db'], lw=1.0)
txt(120, 79.5, 'Shared DB', 6.8, 'bold')
txt(120, 73.5, 'MySQL\n(production)', 5.3, 'normal', TXT)
txt(120, 66.5, 'SQLite\n(local)', 5.3, 'normal', TXT)
txt(120, 58.5, 'control-plane\nstate + history', 4.9, 'normal', SUB, st='italic')

# ──────────────────────── AgentBox ────────────────────────────────
box(MAIN_L, 14, MAIN_R, 46, *C['abox'], lw=1.3)
txt(MAIN_L + 3, 44, 'AgentBox', 7.2, 'bold', '#cc4b3a', ha='left')
txt(MAIN_L + 25, 44, '— one isolated session per user', 5.6, 'normal', SUB, ha='left')
box(97, 41.5, 129, 45.5, '#fdeee9', '#cc4b3a', lw=0.8)
txt(113, 43.5, 'read-only: investigates, never mutates', 5.2, 'bold', '#cc4b3a')

# Agent Brain
box(42, 35, 94, 41, *C['brain'], lw=1.1)
txt(68, 39.2, 'Agent Brain', 6.6, 'bold')
txt(68, 36.3, 'pi-coding-agent + Claude SDK $\\cdot$ deep investigation engine', 5.3, 'normal', TXT)

# Four sub-modules
mods = [('Skills', 'preloaded from\nPortal (g/team/personal)'),
        ('Tools', 'bash, kubectl (ro),\nMCP, mem/knowledge search'),
        ('Memory', 'investigation traces,\nchunks, embeddings'),
        ('Knowledge cache', 'materialized\nwiki pages')]
mx0, mx1 = 8, 129; mw = (mx1 - mx0) / 4
for i, (t, sub) in enumerate(mods):
    cx0 = mx0 + i*mw + 1.2
    cx1 = mx0 + (i+1)*mw - 1.2
    box(cx0, 16.5, cx1, 31, *C['item'], lw=0.8)
    txt((cx0+cx1)/2, 28.0, t, 5.9, 'bold')
    txt((cx0+cx1)/2, 22.5, sub, 4.9, 'normal', SUB)

# ──────────────────────── Targets (bottom) ────────────────────────
txt(MAIN_L + 2, 11.2, 'Read-only investigation targets (outside Siclaw)', 5.8, 'bold', '#5a6b8a', ha='left')
tgts = ['Kubernetes', 'Prometheus / Grafana\nES / Loki', 'Alertmanager /\nPagerDuty', 'SSH hosts', 'MCP extension\nservers']
tx0, tx1 = 5, 131; tw = (tx1 - tx0) / 5
for i, t in enumerate(tgts):
    cx0 = tx0 + i*tw + 1
    cx1 = tx0 + (i+1)*tw - 1
    box(cx0, 1.5, cx1, 8.5, *C['tgt'], lw=0.8)
    txt((cx0+cx1)/2, 5.0, t, 5.3, 'bold')

# ──────────────────────── Right callouts ──────────────────────────
box(SIDE_L, 56, SIDE_R, 82, *C['note'], lw=0.9)
txt(SIDE_L + 3, 79.5, 'Deployment modes', 6.2, 'bold', ha='left')
for i, m in enumerate(['TUI standalone', 'TUI + Local Portal',
                       'Gateway + LocalSpawner', 'Gateway + K8sSpawner']):
    txt(SIDE_L + 4, 74.5 - i*3.6, '$\\bullet$  ' + m, 5.3, 'normal', TXT, ha='left')
txt(SIDE_L + 3, 59.0, 'local: shared FS  $\\cdot$  prod: pod/user + mTLS', 4.8, 'normal', SUB, ha='left', st='italic')

box(SIDE_L, 30, SIDE_R, 52, *C['note'], lw=0.9)
txt(SIDE_L + 3, 49.5, 'Security (6-layer)', 6.2, 'bold', '#cc4b3a', ha='left')
for i, s in enumerate(['OS sandboxing (dual-user)', 'setgid kubectl',
                       'command whitelisting', 'output sanitization']):
    txt(SIDE_L + 4, 44.5 - i*3.6, '$\\bullet$  ' + s, 5.3, 'normal', TXT, ha='left')

box(SIDE_L, 14, SIDE_R, 27, *C['note'], lw=0.9)
txt(SIDE_L + 3, 24.5, 'TUI pairing', 6.0, 'bold', ha='left')
txt(SIDE_L + 3, 20.0, 'local Portal over loopback +\ndedicated secret becomes the\nread-only source of truth', 4.8, 'normal', SUB, ha='left')

# ──────────────────────── Arrows ──────────────────────────────────
for _, cx in chan:                     # channels -> control plane
    arrow(cx, 90, cx, 86.3, lw=0.9)
arrow(68, 50, 68, 46.3, lw=1.4)        # control plane -> AgentBox
txt(70, 48.1, 'session starts (spawn per user)', 5.0, 'normal', SUB, ha='left')
arrow(68, 14, 68, 8.8, lw=1.4)         # AgentBox -> targets
txt(70, 11.3, 'read-only access', 5.0, 'normal', SUB, ha='left')

fig.savefig('figures/overview.pdf')
fig.savefig('figures/overview.png', dpi=200)
print('Generated figures/overview.pdf + .png')
