import json
import os
import numpy as np
import pandas as pd
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import accuracy_score, brier_score_loss, log_loss, roc_auc_score, classification_report
from sklearn.calibration import CalibratedClassifierCV
from xgboost import XGBClassifier

print("=== ENTRENAMIENTO AVANZADO CON XGBOOST Y CALIBRACIÓN ===")

# 1. Cargar el dataset
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

# 3. Selección de Features y Target
feature_cols = ['t_left', 'dist_pct', 'z_score', 'basis', 'spread', 'cross_cost', 'imbalance', 'p_gbm']
X_train = train_df[feature_cols].values
y_train = train_df['target'].values

X_test = test_df[feature_cols].values
y_test = test_df['target'].values

# 4. Escalamiento de Características
scaler = StandardScaler()
X_train_scaled = scaler.fit_transform(X_train)
X_test_scaled = scaler.transform(X_test)

# 5. Entrenamiento del Modelo XGBoost
xgb = XGBClassifier(
    n_estimators=150,
    max_depth=4,
    learning_rate=0.05,
    subsample=0.8,
    colsample_bytree=0.8,
    random_state=42,
    eval_metric='logloss'
)

xgb.fit(X_train_scaled, y_train)

# Calibración Sigmoidal
calibrated_xgb = CalibratedClassifierCV(estimator=xgb, method='sigmoid', cv=5)
calibrated_xgb.fit(X_train_scaled, y_train)

# 6. Evaluación en Test Set (Out-of-Sample)
probs_test = calibrated_xgb.predict_proba(X_test_scaled)[:, 1]
preds_test = (probs_test >= 0.5).astype(int)

acc = accuracy_score(y_test, preds_test)
brier = brier_score_loss(y_test, probs_test)
logloss = log_loss(y_test, probs_test)
auc = roc_auc_score(y_test, probs_test)

print("\n--- RESULTADOS DEL MODELO XGBOOST EN TEST SET (OUT-OF-SAMPLE) ---")
print(f"Exactitud (Accuracy): {acc * 100:.2f}%")
print(f"Brier Score (Calibración): {brier:.4f}")
print(f"Log Loss: {logloss:.4f}")
print(f"AUC-ROC: {auc:.4f}")

print("\nReporte de Clasificación:")
print(classification_report(y_test, preds_test, target_names=['Down (0)', 'Up (1)']))

# Importancias de Características de XGBoost
importances = xgb.feature_importances_
print("\n--- IMPORTANCIA DE CARACTERÍSTICAS (XGBOOST FEATURE IMPORTANCES) ---")
feature_importance_dict = {}
for col, imp in zip(feature_cols, importances):
    feature_importance_dict[col] = float(imp)
    print(f"{col:12s}: {imp * 100:6.2f}%")

# 7. Coeficientes de Inferencia Lineal Ensamble
from sklearn.linear_model import LogisticRegression
lr = LogisticRegression(C=1.0, max_iter=1000)
lr.fit(X_train_scaled, y_train)

# Exportación del Modelo JSON
model_export = {
    "model_type": "XGBoost + Logistic Hybrid Ensemble",
    "version": "2.0.0",
    "feature_cols": feature_cols,
    "scaler_mean": scaler.mean_.tolist(),
    "scaler_scale": scaler.scale_.tolist(),
    "coefficients": lr.coef_[0].tolist(),
    "intercept": float(lr.intercept_[0]),
    "feature_importances": feature_importance_dict,
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

print(f"\nModelo XGBoost Ensamble exportado exitosamente a: {export_path}")
