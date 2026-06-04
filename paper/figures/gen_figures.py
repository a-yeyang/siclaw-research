#!/usr/bin/env python3
"""
Generate publication-quality figures for the AAAI paper.
Clean redesign: legends placed ABOVE the plot area (never overlapping bars),
threshold/avg labels placed in genuinely empty bands, no in-plot group text.
Outputs both PDF (for LaTeX) and PNG (for visual inspection).
"""
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.patches import Patch

COL_WIDTH = 3.25  # AAAI single column width (inches)

plt.rcParams.update({
    'font.family': 'serif',
    'font.serif': ['Times New Roman', 'Times', 'DejaVu Serif'],
    'font.size': 8,
    'axes.labelsize': 8,
    'axes.titlesize': 8,
    'xtick.labelsize': 6.5,
    'ytick.labelsize': 7,
    'legend.fontsize': 7,
    'figure.dpi': 300,
    'savefig.dpi': 300,
    'savefig.bbox': 'tight',
    'savefig.pad_inches': 0.02,
    'axes.linewidth': 0.6,
    'grid.linewidth': 0.3,
    'lines.linewidth': 1.0,
    'patch.linewidth': 0.4,
})

COLORS = {
    'blue': '#3b6fb0', 'orange': '#e07b39', 'green': '#3a9b54',
    'purple': '#7e6bb0', 'red': '#cc4b3a', 'gray': '#666666',
    'lightblue': '#7ba6d4', 'lightorange': '#f0a868',
}

def save(fig, name):
    fig.savefig(f'figures/{name}.pdf')
    fig.savefig(f'figures/{name}.png', dpi=200)
    plt.close(fig)
    print(f"Generated: figures/{name}.pdf + .png")


# ════════════════════════════════════════════════════════════════
# Figure 2: Diagnostic Performance by Category
# ════════════════════════════════════════════════════════════════
def fig_diagnostic_performance():
    categories = ['Image\nPull', 'Crash\nLoop', 'Config', 'Sched\nGPU', 'Storage',
                  'Service\nRdy', 'Net\nDNS', 'Ctrl', 'Volc\nGPU', 'Comp\nound']
    pass_rates = [90, 100, 100, 80, 100, 100, 70, 87, 100, 71]
    avg_scores = [0.843, 0.938, 0.895, 0.808, 0.863, 0.758, 0.780, 0.726, 0.833, 0.703]
    difficulties = ['easy']*5 + ['medium']*3 + ['hard']*2

    fig, ax = plt.subplots(figsize=(COL_WIDTH, 1.95))
    x = np.arange(len(categories))
    cmap = {'easy': COLORS['lightblue'], 'medium': COLORS['lightorange'], 'hard': COLORS['red']}
    colors = [cmap[d] for d in difficulties]

    ax.bar(x, avg_scores, 0.66, color=colors, edgecolor='white', linewidth=0.4, zorder=3)

    # pass-rate numbers above bars
    for i, (rate, score) in enumerate(zip(pass_rates, avg_scores)):
        ax.text(i, score + 0.02, f'{rate}', ha='center', va='bottom',
                fontsize=5.8, color=COLORS['gray'], zorder=4)

    # threshold line + label in the EMPTY band below all bars (min bar = 0.703)
    ax.axhline(y=0.65, color=COLORS['gray'], linestyle='--', linewidth=0.6, zorder=2)
    ax.text(-0.35, 0.50, '0.65 pass threshold', fontsize=5.8, color=COLORS['gray'],
            ha='left', va='center')

    ax.set_xticks(x)
    ax.set_xticklabels(categories, fontsize=6)
    ax.set_ylabel('Avg. Checklist Score')
    ax.set_ylim(0, 1.0)
    ax.set_yticks([0, 0.2, 0.4, 0.6, 0.8, 1.0])
    ax.set_xlim(-0.6, 9.6)
    ax.spines['top'].set_visible(False)
    ax.spines['right'].set_visible(False)
    ax.tick_params(width=0.6)

    # legend ABOVE the axes (never overlaps bars)
    legend_elements = [
        Patch(facecolor=COLORS['lightblue'], label='Easy'),
        Patch(facecolor=COLORS['lightorange'], label='Medium'),
        Patch(facecolor=COLORS['red'], label='Hard'),
    ]
    ax.legend(handles=legend_elements, loc='lower center', bbox_to_anchor=(0.5, 1.0),
              ncol=3, frameon=False, fontsize=7, handlelength=1.1,
              handleheight=0.9, columnspacing=1.4, borderpad=0.2)

    save(fig, 'diagnostic-performance')


# ════════════════════════════════════════════════════════════════
# Figure 3: Security Layer Ablation (horizontal bars)
# ════════════════════════════════════════════════════════════════
def fig_security_ablation():
    layers = ['L1: Shell Ops', 'L2: Whitelist', 'L4: Output San.',
              'L5: Cmd Restrict', 'L6: Sens. Path']
    coverage = [10.0, 70.0, 13.3, 46.7, 23.3]

    fig, ax = plt.subplots(figsize=(COL_WIDTH, 1.55))
    y = np.arange(len(layers))
    bars = ax.barh(y, coverage, height=0.62, color=COLORS['blue'],
                   edgecolor='white', linewidth=0.4, zorder=3)

    for i, val in enumerate(coverage):
        ax.text(val + 1.5, i, f'{val:.0f}%', va='center', fontsize=6.5, zorder=4)

    # combined-coverage reference line at 100%
    ax.axvline(x=100, color=COLORS['green'], linewidth=1.3, zorder=2)

    ax.set_yticks(y)
    ax.set_yticklabels(layers, fontsize=7)
    ax.set_xlabel('Independent Attack Coverage (%)')
    ax.set_xlim(0, 118)
    ax.set_xticks([0, 20, 40, 60, 80, 100])
    ax.spines['top'].set_visible(False)
    ax.spines['right'].set_visible(False)
    ax.tick_params(width=0.6)
    ax.invert_yaxis()

    # "100% combined" label placed in clear space at top-right, above bars
    ax.annotate('100%\ncombined', xy=(100, -0.05), xytext=(109, 0.55),
                fontsize=6, color=COLORS['green'], ha='center', va='center',
                annotation_clip=False)

    save(fig, 'security-ablation')


# ════════════════════════════════════════════════════════════════
# Figure 4: GPU/RDMA Diagnosis Results
# ════════════════════════════════════════════════════════════════
def fig_gpu_rdma():
    cases = ['g01', 'g02', 'g03', 'g04', 'g05', 'g06', 'g07', 'g08', 'g09', 'g10']
    scores = [0.961, 0.991, 0.926, 0.972, 0.895, 0.921, 0.799, 0.945, 0.975, 0.841]
    # category order matches the case list: GPU(g01-03), RDMA(g04-05), GPU(g06-07), RDMA(g08), Compound(g09-10)
    cats = ['GPU', 'GPU', 'GPU', 'RDMA', 'RDMA', 'GPU', 'GPU', 'RDMA', 'Comp', 'Comp']
    cat_colors = {'GPU': COLORS['blue'], 'RDMA': COLORS['orange'], 'Comp': COLORS['purple']}

    fig, ax = plt.subplots(figsize=(COL_WIDTH, 1.85))
    x = np.arange(len(cases))
    colors = [cat_colors[c] for c in cats]

    ax.bar(x, scores, 0.66, color=colors, edgecolor='white', linewidth=0.4, zorder=3)

    # average line + label in the clear right margin (no bar there)
    avg = float(np.mean(scores))
    ax.axhline(y=avg, color=COLORS['green'], linewidth=0.9, linestyle='-', zorder=2)
    ax.annotate(f'avg\n{avg:.3f}', xy=(9.5, avg), xytext=(10.0, avg),
                fontsize=6, color=COLORS['green'], ha='center', va='center',
                annotation_clip=False)

    ax.set_xticks(x)
    ax.set_xticklabels(cases, fontsize=6.5)
    ax.set_ylabel('Checklist Score')
    ax.set_ylim(0.6, 1.02)
    ax.set_yticks([0.6, 0.7, 0.8, 0.9, 1.0])
    ax.set_xlim(-0.6, 10.4)
    ax.spines['top'].set_visible(False)
    ax.spines['right'].set_visible(False)
    ax.tick_params(width=0.6)

    legend_elements = [
        Patch(facecolor=COLORS['blue'], label='GPU Hardware'),
        Patch(facecolor=COLORS['orange'], label='RDMA Network'),
        Patch(facecolor=COLORS['purple'], label='Compound'),
    ]
    ax.legend(handles=legend_elements, loc='lower center', bbox_to_anchor=(0.5, 1.0),
              ncol=3, frameon=False, fontsize=6.5, handlelength=1.1,
              handleheight=0.9, columnspacing=1.2, borderpad=0.2)

    save(fig, 'gpu-rdma-results')


if __name__ == '__main__':
    fig_diagnostic_performance()
    fig_security_ablation()
    fig_gpu_rdma()
    print("\nAll figures regenerated.")
