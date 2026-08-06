import json
import numpy as np
import matplotlib.pyplot as plt
from sklearn.metrics import roc_curve, auc
from sklearn.calibration import calibration_curve

# Configurar estilo visual limpio
plt.style.use('seaborn-v0_8-paper' if 'seaborn-v0_8-paper' in plt.style.available else 'default')
plt.rcParams.update({
    'font.family': 'sans-serif',
    'font.size': 10,
    'axes.labelsize': 11,
    'axes.titlesize': 12,
    'figure.dpi': 300
})

# Cargar datos empíricos extraídos de pmbtc.db
with open('plots_data_real.json', 'r') as f:
    data = json.load(f)

y_true = np.array(data['y_true'])
predictions = np.array(data['predictions'])

# -------------------------------------------------------------------------
# Figura 2 REAL: Curva ROC Empírica Real y Diagrama de Calibración Real
# -------------------------------------------------------------------------
fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(10, 4.5))

# Subplot A: Curva ROC Real de la Base de Datos SQLite
fpr, tpr, _ = roc_curve(y_true, predictions)
roc_auc = auc(fpr, tpr)

ax1.plot(fpr, tpr, color='#e056fd', linewidth=2, label=f'Modelo Empírico Real (AUC = {roc_auc:.4f})')
ax1.plot([0, 1], [0, 1], color='#888888', linestyle='--', label='Clasificador Aleatorio (AUC = 0.5000)')
ax1.set_title(f'(A) Curva ROC Empírica Real (AUC = {roc_auc:.4f})', pad=10)
ax1.set_xlabel('Tasa de Falsos Positivos (1 - Especificidad)')
ax1.set_ylabel('Tasa de Verdaderos Positivos (Sensibilidad)')
ax1.grid(True, linestyle=':', alpha=0.6)
ax1.legend(loc='lower right')

# Subplot B: Diagrama de Calibración Real (Reliability Diagram)
prob_true, prob_pred = calibration_curve(y_true, predictions, n_bins=10)

ax2.plot([0, 1], [0, 1], color='#888888', linestyle='--', label='Calibración Perfecta (Ideal)')
ax2.plot(prob_pred, prob_true, 'o-', color='#00ff66', linewidth=2, label='Calibración Empírica Real (pmbtc.db)')
ax2.set_title('(B) Diagrama de Calibración Probabilística Real', pad=10)
ax2.set_xlabel('Probabilidad Predicha P(Up)')
ax2.set_ylabel('Frecuencia Observada Real de Up')
ax2.grid(True, linestyle=':', alpha=0.6)
ax2.legend(loc='upper left')

plt.tight_layout()
plt.savefig('plots/fig2_calibration_roc.png', dpi=300)
plt.savefig('fig2_calibration_roc.png', dpi=300)
plt.close()

print(f"¡Figura 2 REAL generada con AUC Real de {roc_auc:.4f}!")
