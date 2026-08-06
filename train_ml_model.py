import json
import os
import numpy as np
import pandas as pd
from sklearn.preprocessing import StandardScaler
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, brier_score_loss, log_loss, roc_auc_score, classification_report
from sklearn.calibration import CalibratedClassifierCV

print("=== ENTRENAMIENTO Y CALIBRACIÓN DEL MODELO DE MACHINE LEARNING ===")

# 1. Cargar el dataset generado
data_path = os.path.join(os.path.dirname(__file__), 'data', 'ml_dataset.json')
with open(data_path, 'r') as f:
    raw_data = json.load(f)

df = pd.DataFrame(raw_data)
print(f"Total de datos cargados: {len(df)} muestras.")

# 2. Divisón Cronológica por Velas (TimeSeriesSplit)
unique_buckets = sorted(df['start_ts'].unique())
n_buckets = len(unique_buckets)
split_idx = int(n_buckets * 0.8)

train_buckets = set(unique_buckets[:split_idx])
test_buckets = set(unique_buckets[split_idx:])

train_df = df[df['start_ts'].isin(train_buckets)].copy()
test_df = df[df['start_ts'].isin(test_buckets)].copy()

print(f"Velas de Entrenamiento: {len(train_buckets)} | Velas de Test (Out-of-sample): {len(test_buckets)}")
print(f"Muestras de Train: {len(train_df)} | Muestras de Test: {len(test_df)}")

# 3. Selección de Features y Target
feature_cols = ['t_left', 'dist_pct', 'z_score', 'basis', 'spread', 'cross_cost', 'imbalance', 'p_gbm']
X_train = train_df[feature_cols].values
y_train = train_df['target'].values

X_test = test_df[feature_cols].values
y_test = test_df['target'].values

# 4. Escalamiento de Características (Fit únicamente en Train)
scaler = StandardScaler()
X_train_scaled = scaler.fit_transform(X_train)
X_test_scaled = scaler.transform(X_test)

# 5. Entrenamiento del Clasificador Calibrado
base_clf = LogisticRegression(C=1.0, max_iter=1000, solver='lbfgs')
calibrated_clf = CalibratedClassifierCV(estimator=base_clf, method='sigmoid', cv=5)
calibrated_clf.fit(X_train_scaled, y_train)

base_clf.fit(X_train_scaled, y_train)

# 6. Evaluación Out-of-Sample (Test Set)
probs_test = calibrated_clf.predict_proba(X_test_scaled)[:, 1]
preds_test = (probs_test >= 0.5).astype(int)

acc = accuracy_score(y_test, preds_test)
brier = brier_score_loss(y_test, probs_test)
logloss = log_loss(y_test, probs_test)
auc = roc_auc_score(y_test, probs_test)

print("\n--- RESULTADOS EN EL TEST SET (OUT-OF-SAMPLE) ---")
print(f"Exactitud (Accuracy): {acc * 100:.2f}%")
print(f"Brier Score (Calibración): {brier:.4f}")
print(f"Log Loss: {logloss:.4f}")
print(f"AUC-ROC: {auc:.4f}")

print("\nReporte de Clasificación:")
print(classification_report(y_test, preds_test, target_names=['Down (0)', 'Up (1)']))

# Importancia / Coeficientes de Características
coefficients = base_clf.coef_[0]
print("\n--- PESOS Y PESO DE CARACTERÍSTICAS (COEFICIENTES) ---")
for col, coef in zip(feature_cols, coefficients):
    print(f"{col:12s}: {coef:+.4f}")

# 7. Exportación del Modelo a JSON para Inferencia Nativa en Node.js
model_export = {
    "version": "1.0.0",
    "feature_cols": feature_cols,
    "scaler_mean": scaler.mean_.tolist(),
    "scaler_scale": scaler.scale_.tolist(),
    "coefficients": coefficients.tolist(),
    "intercept": float(base_clf.intercept_[0]),
    "metrics": {
        "accuracy": round(float(acc), 4),
        "brier_score": round(float(brier), 4),
        "log_loss": round(float(logloss), 4),
        "auc_roc": round(float(auc), 4),
        "train_samples": len(train_df),
        "test_samples": len(test_df),
        "test_buckets": len(test_buckets)
    }
}

export_path = os.path.join(os.path.dirname(__file__), 'src', 'ml_model.json')
with open(export_path, 'w') as f:
    json.dump(model_export, f, indent=2)

print(f"\nModelo exportado exitosamente a: {export_path}")
