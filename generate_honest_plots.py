import json
import numpy as np
import matplotlib.pyplot as plt
from sklearn.metrics import roc_curve, auc
from sklearn.calibration import calibration_curve

# Configurar estilo visual limpio de alta resolución (300 DPI)
plt.style.use('seaborn-v0_8-paper' if 'seaborn-v0_8-paper' in plt.style.available else 'default')
plt.rcParams.update({
    'font.family': 'sans-serif',
    'font.size': 10,
    'axes.labelsize': 11,
    'axes.titlesize': 12,
    'figure.dpi': 300
})

# Cargar datos a nivel de vela N=407 (sin pseudoreplicación)
with open('plots_data_candle_level.json', 'r') as f:
    data = json.load(f)

candle_preds = np.array(data['candle_predictions'])
candle_y = np.array(data['candle_y_true'])
time_bins = data['time_binned_data']

# -------------------------------------------------------------------------
# Figura 2 AUDITADA: (A) ROC Nivel de Vela N=407 y (B) Degradación de AUC por t_left
# -------------------------------------------------------------------------
fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(10, 4.5))

# Subplot A: Curva ROC a Nivel de Vela (N=407 independientes, sin pseudoreplicación)
fpr, tpr, _ = roc_curve(candle_y, candle_preds)
candle_auc = auc(fpr, tpr)

ax1.plot(fpr, tpr, color='#00f3ff', linewidth=2.2, label=f'AUC Nivel Vela N=407 ({candle_auc:.4f})')
ax1.plot([0, 1], [0, 1], color='#888888', linestyle='--', label='Azar Aleatorio (AUC = 0.5000)')
ax1.set_title(f'(A) ROC a Nivel de Vela N=407 (AUC Real = {candle_auc:.4f})', pad=10)
ax1.set_xlabel('Tasa de Falsos Positivos')
ax1.set_ylabel('Tasa de Verdaderos Positivos')
ax1.grid(True, linestyle=':', alpha=0.6)
ax1.legend(loc='lower right')

# Subplot B: AUC por Ventana de Tiempo t_left (Demostrando Fuga de Información al Vencimiento)
bin_labels = []
bin_aucs = []

for label, bdata in time_bins.items():
    preds = np.array(bdata['preds'])
    y = np.array(bdata['y'])
    if len(y) > 0 and len(np.unique(y)) > 1:
        f_b, t_b, _ = roc_curve(y, preds)
        bin_aucs.append(auc(f_b, t_b))
        bin_labels.append(label.split(' ')[0])

x_pos = np.arange(len(bin_labels))
colors = ['#ff0055', '#ffaa00', '#00f3ff', '#00ff66']

bars = ax2.bar(x_pos, bin_aucs, color=colors, alpha=0.85, width=0.55, edgecolor='#333333')
ax2.axhline(0.50, color='#888888', linestyle='--', label='Azar (0.50)')
ax2.set_xticks(x_pos)
ax2.set_xticklabels(bin_labels, rotation=15)
ax2.set_ylim(0.40, 1.00)
ax2.set_title('(B) Decaimiento de AUC por Tiempo Restante (t_left)', pad=10)
ax2.set_xlabel('Ventana de Tiempo Restante (t_left en Velas de 15m)')
ax2.set_ylabel('Área Bajo la Curva (AUC)')
ax2.grid(True, axis='y', linestyle=':', alpha=0.6)

for bar, score in zip(bars, bin_aucs):
    yval = bar.get_height()
    ax2.text(bar.get_x() + bar.get_width()/2.0, yval + 0.02, f'{score:.3f}', ha='center', va='bottom', fontweight='bold')

plt.tight_layout()
plt.savefig('plots/fig2_calibration_roc.png', dpi=300)
plt.savefig('fig2_calibration_roc.png', dpi=300)
plt.close()

print(f"¡Figura 2 AUDITADA generada con AUC a Nivel de Vela (N=407) = {candle_auc:.4f}!")
