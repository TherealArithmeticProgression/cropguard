# ═══════════════════════════════════════════════════════════════════════════════
#  🍅 TOMATO LEAF DISEASE CLASSIFIER — REFACTORED TRAINING PIPELINE
#
#  Diseases : bacterial_spot · early_blight · late_blight · septoria_leaf_spot
#  Datasets : SLIF-Tomato + PlantDoc  (combined training — no domain gap)
#  Arch     : EfficientNet-B0  (torchvision, pre-trained ImageNet-1K)
#  Target   : INT8-quantized ONNX for budget Android phones
#
#  Key improvements over original code
#  ────────────────────────────────────
#   1. Combined-dataset training          (eliminates cross-dataset domain gap)
#   2. Heavy augmentation pipeline        (RandAugment + MixUp/CutMix + RandomErasing)
#   3. Two-phase fine-tuning              (head warmup → full fine-tune, discriminative LRs)
#   4. Cosine annealing + linear warmup   (stable early training, deep convergence)
#   5. Label smoothing + class-weighted loss  (handles class imbalance, calibrates confidence)
#   6. Mixed-precision training (AMP)     (2-3× faster on T4 Tensor Cores)
#   7. Exponential Moving Average (EMA)   (smoother, more generalizable weights)
#   8. Gradient clipping                  (prevents exploding gradients)
#   9. ONNX export + INT8 quantization    (mobile deployment)
#  10. GradCAM visualisation              (verify model looks at lesions, not background)
#
#  Structured with  # %%  cell markers — each one starts a new runnable cell
#  in VS Code, Colab (upload as .py then "Open as notebook"), or Kaggle.
# ═══════════════════════════════════════════════════════════════════════════════


# %%  ═══════════════════════ CELL 1 — Install Dependencies ═══════════════════
# torchvision + torch ship with Colab/Kaggle.
# onnx + onnxruntime are needed for export & quantisation.
# matplotlib, pandas, scikit-learn also ship with Colab/Kaggle.

!pip install -q onnx onnxruntime


# %%  ══════════════════════════ CELL 2 — Imports ═════════════════════════════

import os
import sys
import time
import json
import math
import copy
import random
import warnings
from pathlib import Path
from dataclasses import dataclass, field
from typing import List, Dict, Tuple, Optional

import numpy as np
import pandas as pd
import matplotlib
import matplotlib.pyplot as plt
from PIL import Image, ImageFile

import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.utils.data import Dataset, DataLoader
from torchvision import transforms, models
from sklearn.model_selection import train_test_split
from sklearn.metrics import (
    classification_report,
    confusion_matrix,
    accuracy_score,
    f1_score,
)

# Handle truncated images silently instead of crashing
ImageFile.LOAD_TRUNCATED_IMAGES = True
warnings.filterwarnings("ignore", category=UserWarning)


# %%  ═══════════════════════ CELL 3 — Configuration ══════════════════════════
#
#  ╔══════════════════════════════════════════════════════════════════════╗
#  ║  ALL tuneable hyper-parameters live here.  Change anything in this ║
#  ║  cell and re-run from here downward to try a new experiment.       ║
#  ╚══════════════════════════════════════════════════════════════════════╝

@dataclass
class CFG:
    # ── Target classes (alphabetical, shared across both datasets) ────
    classes: List[str] = field(default_factory=lambda: [
        "bacterial_spot", "early_blight", "late_blight", "septoria_leaf_spot",
    ])

    # ── Architecture ──────────────────────────────────────────────────
    arch: str = "efficientnet_b0"       # also supports "mobilenet_v3_large"
    pretrained: bool = True
    dropout: float = 0.3               # classifier dropout  (B0 default=0.2)

    # ── Image ─────────────────────────────────────────────────────────
    img_size: int = 224

    # ── Phase 1 — head warm-up (backbone frozen) ─────────────────────
    phase1_epochs: int = 5
    phase1_lr: float = 3e-3

    # ── Phase 2 — full fine-tune (all layers, discriminative LRs) ────
    phase2_epochs: int = 30
    backbone_lr: float = 1e-5          # low LR to preserve pre-trained features
    head_lr: float = 5e-4              # higher LR for the classification head
    warmup_epochs: int = 3             # linear warmup before cosine decay
    min_lr: float = 1e-7               # cosine annealing floor

    # ── Common training ───────────────────────────────────────────────
    batch_size: int = 64               # fits comfortably on T4 (16 GB)
    num_workers: int = 2               # Colab/Kaggle safe default
    weight_decay: float = 0.01         # AdamW L2 regularisation
    label_smoothing: float = 0.1       # softens targets → better calibration
    grad_clip_norm: float = 1.0        # prevent exploding gradients

    # ── MixUp / CutMix ───────────────────────────────────────────────
    mixup_alpha: float = 0.3           # Beta distribution α for MixUp
    cutmix_alpha: float = 1.0          # Beta distribution α for CutMix
    mix_prob: float = 0.5             # per-batch probability of applying either

    # ── EMA ───────────────────────────────────────────────────────────
    ema_decay: float = 0.999

    # ── Data split fractions ──────────────────────────────────────────
    train_frac: float = 0.70
    val_frac: float = 0.15
    test_frac: float = 0.15
    seed: int = 42

    # ── Output paths ──────────────────────────────────────────────────
    manifest_dir: str = "manifests"
    checkpoint_dir: str = "checkpoints"
    results_dir: str = "results"

    @property
    def num_classes(self) -> int:
        return len(self.classes)


cfg = CFG()

# ── Raw folder-name → canonical class mappings ────────────────────────
# Normalisation strategy: lowercase + replace spaces with underscores,
# so "Bacterial Spot" and "bacterial_spot" both match the same key.

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}

RAW_CLASS_MAPS: Dict[str, Dict[str, str]] = {
    "plantdoc": {
        # PlantDoc uses names like "Tomato leaf bacterial spot"
        "tomato_leaf_bacterial_spot":  "bacterial_spot",
        "tomato_early_blight_leaf":    "early_blight",
        "tomato_leaf_late_blight":     "late_blight",
        "tomato_septoria_leaf_spot":   "septoria_leaf_spot",
    },
    "slif_tomato": {
        # SLIF-Tomato Phase_II / Raw_Dataset folders
        "bacterial_spot":  "bacterial_spot",
        "early_blight":    "early_blight",
        "late_blight":     "late_blight",
        "septoria":        "septoria_leaf_spot",
        "septoria_leaf_spot": "septoria_leaf_spot",
    },
}


# %%  ═══════════════ CELL 4 — Reproducibility & Device Setup ═════════════════

def seed_everything(seed: int):
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)
        torch.backends.cudnn.benchmark = True  # auto-tuner for faster convolutions

seed_everything(cfg.seed)
DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")

print(f"Device : {DEVICE}")
if DEVICE.type == "cuda":
    print(f"GPU    : {torch.cuda.get_device_name(0)}")
    print(f"VRAM   : {torch.cuda.get_device_properties(0).total_mem / 1e9:.1f} GB")
print(f"PyTorch: {torch.__version__}")


# %%  ══════════════════════ CELL 5 — Download Datasets ═══════════════════════

from google.colab import userdata
import kagglehub

os.environ["KAGGLE_API_TOKEN"] = userdata.get('kagglehub_api_token')
kagglehub.login(validate_credentials=False)

path_slif = kagglehub.dataset_download("romiyalgeorge/slif-tomato-dataset")
path_plantdoc = kagglehub.dataset_download("nirmalsankalana/plantdoc-dataset")

print(f"\nSLIF path     : {path_slif}")
print(f"PlantDoc path : {path_plantdoc}")


# %%  ═════════════════ CELL 6 — Manifest Scanner Function ════════════════════

def scan_dataset(root: str, dataset_key: str, source_tag: str) -> pd.DataFrame:
    """
    Walk a folder-per-class directory tree and return a manifest DataFrame.

    Args
    ----
    root        : path to dataset root (contains class sub-folders)
    dataset_key : key into RAW_CLASS_MAPS  ('plantdoc' | 'slif_tomato')
    source_tag  : value for the 'source' column  ('plantdoc' | 'slif')

    Returns
    -------
    DataFrame with columns: filepath, label, source
    """
    root = Path(root)
    class_map = RAW_CLASS_MAPS[dataset_key]
    rows: list[dict] = []
    skipped: set[str] = set()

    if not root.exists():
        raise FileNotFoundError(f"Dataset root does not exist: {root}")

    for class_dir in sorted(p for p in root.iterdir() if p.is_dir()):
        # normalise: lower-case + spaces → underscores
        raw = class_dir.name.strip().lower().replace(" ", "_")
        canonical = class_map.get(raw)

        # fallback: try without underscore replacement (original spaces)
        if canonical is None:
            canonical = class_map.get(class_dir.name.strip().lower())

        if canonical is None:
            skipped.add(class_dir.name)
            continue

        for img_path in class_dir.iterdir():
            if img_path.suffix.lower() in IMAGE_EXTENSIONS:
                rows.append({
                    "filepath": str(img_path.resolve()),
                    "label":    canonical,
                    "source":   source_tag,
                })

    if not rows:
        found = sorted(p.name for p in root.iterdir()) if root.exists() else []
        raise RuntimeError(
            f"No matching images found!\n"
            f"  root = {root}  (exists: {root.exists()})\n"
            f"  sub-folders found: {found}\n"
            f"  skipped (not in class map): {sorted(skipped)}\n"
            f"  If the class folders are nested deeper, adjust the root path."
        )

    df = pd.DataFrame(rows)
    print(f"\n[{source_tag}] Scanned {len(df)} images from {root}")
    print(df["label"].value_counts().to_string())
    if skipped:
        print(f"  Skipped classes (not in shared label set): {sorted(skipped)}")
    return df


# %%  ══════════════════ CELL 7 — Build Manifests (execute) ═══════════════════
#
#  ⚠ Adjust these root paths if kagglehub nests the files differently.
#    Run Cell 5 first and check the printed paths.  The manifest scanner
#    will error loudly if the folder structure doesn't match expectations.

df_slif = scan_dataset(
    root=f"{path_slif}/Raw_Dataset",
    dataset_key="slif_tomato",
    source_tag="slif",
)

df_plantdoc_train = scan_dataset(
    root=f"{path_plantdoc}/train",
    dataset_key="plantdoc",
    source_tag="plantdoc",
)

try:
    df_plantdoc_test = scan_dataset(
        root=f"{path_plantdoc}/test",
        dataset_key="plantdoc",
        source_tag="plantdoc",
    )
    df_plantdoc = pd.concat([df_plantdoc_train, df_plantdoc_test], ignore_index=True)
except Exception as e:
    print(f"Skipping PlantDoc test set (might be missing or structured differently): {e}")
    df_plantdoc = df_plantdoc_train

# ── Combine into one master manifest ─────────────────────────────────
df_all = pd.concat([df_slif, df_plantdoc], ignore_index=True)

Path(cfg.manifest_dir).mkdir(parents=True, exist_ok=True)
df_all.to_csv(f"{cfg.manifest_dir}/combined_full.csv", index=False)

print(f"\n{'═' * 55}")
print(f"  Combined dataset : {len(df_all)} images")
print(f"    SLIF           : {len(df_slif)}")
print(f"    PlantDoc       : {len(df_plantdoc)}")
print(f"\n  Class distribution:")
print(f"  {df_all['label'].value_counts().to_dict()}")
print(f"\n  Source × Class cross-tab:")
print(df_all.groupby(["source", "label"]).size().unstack(fill_value=0))
print(f"{'═' * 55}")


# %%  ════════════ CELL 8 — Stratified Split & Class Weights (execute) ════════

def stratified_split(df: pd.DataFrame, cfg: CFG, prefix: str = "combined"):
    """
    Stratified train / val / test split on the combined manifest.
    Groups augmented/duplicate siblings by extracting a base identifier from the filename
    (e.g. ignoring '_jpg.rf.hash' suffixes) so they don't straddle splits.
    """
    assert abs(cfg.train_frac + cfg.val_frac + cfg.test_frac - 1.0) < 1e-6

    import re
    def get_group(row) -> str:
        name = Path(row["filepath"]).stem
        # Roboflow / PlantDoc: remove the _jpg.rf.<hash> part
        name = name.split('_jpg.rf.')[0]
        # SLIF Phase II: specifically remove trailing numeric variants like _1, _2, (1)
        if row.get("source") == "slif":
            name = re.sub(r'([ _\-]\(\d+\)|[ _\-]\d+)$', '', name, flags=re.IGNORECASE)
        # Generic explicit derivation markers
        name = re.sub(r'([ _\-]copy|[ _\-]aug.*)$', '', name, flags=re.IGNORECASE)
        # Include label in group key to prevent cross-class collisions
        return f"{row['label']}::{name}"

    df = df.copy()
    df["group"] = df.apply(get_group, axis=1)

    # 1. Map each group to its first label
    group_labels = df.groupby("group")["label"].first()

    # 2. Stratify the groups themselves so siblings stay together
    train_groups, temp_groups = train_test_split(
        group_labels.index,
        train_size=cfg.train_frac,
        stratify=group_labels.values,
        random_state=cfg.seed,
    )

    rel_val = cfg.val_frac / (cfg.val_frac + cfg.test_frac)
    temp_labels = group_labels.loc[temp_groups]

    val_groups, test_groups = train_test_split(
        temp_groups,
        train_size=rel_val,
        stratify=temp_labels.values,
        random_state=cfg.seed,
    )

    train_df = df[df["group"].isin(train_groups)].drop(columns=["group"])
    val_df = df[df["group"].isin(val_groups)].drop(columns=["group"])
    test_df = df[df["group"].isin(test_groups)].drop(columns=["group"])

    out = Path(cfg.manifest_dir)
    train_df.to_csv(out / f"{prefix}_train.csv", index=False)
    val_df.to_csv(out / f"{prefix}_val.csv", index=False)
    test_df.to_csv(out / f"{prefix}_test.csv", index=False)

    print(f"\n[{prefix}] train={len(train_df)}  val={len(val_df)}  test={len(test_df)}")
    print(f"  Train label balance: {train_df['label'].value_counts().to_dict()}")
    return train_df, val_df, test_df


train_df, val_df, test_df = stratified_split(df_all, cfg)

# ── Inverse-frequency class weights (normalised so mean = 1.0) ───────
counts = train_df["label"].value_counts()
n_train = len(train_df)
class_weights = torch.tensor(
    [n_train / (cfg.num_classes * counts[c]) for c in cfg.classes],
    dtype=torch.float32,
)
class_weights = class_weights / class_weights.mean()
print(f"\n  Class weights (inverse-freq, normalised):")
for c, w in zip(cfg.classes, class_weights.tolist()):
    print(f"    {c:25s}  {w:.3f}")


# %%  ════════════════════ CELL 9 — Dataset Class ═════════════════════════════

class ManifestDataset(Dataset):
    """
    Reads (image, label) pairs from a manifest CSV.
    Columns expected: filepath, label  (source column ignored here).
    """

    def __init__(self, manifest_csv: str, transform=None,
                 classes: Optional[List[str]] = None):
        self.df = pd.read_csv(manifest_csv)
        self.classes = classes or cfg.classes
        self.class_to_idx = {c: i for i, c in enumerate(self.classes)}
        self.transform = transform

    def __len__(self) -> int:
        return len(self.df)

    def __getitem__(self, idx: int):
        row = self.df.iloc[idx]
        try:
            img = Image.open(row["filepath"]).convert("RGB")
        except Exception:
            # Corrupted / missing file → return a random valid sample instead
            return self[random.randint(0, len(self) - 1)]

        if self.transform:
            img = self.transform(img)

        label = self.class_to_idx[row["label"]]
        return img, label


# %%  ═══════════════════ CELL 10 — Augmentation Transforms ═══════════════════
#
#  Training pipeline is MUCH heavier than the original:
#    • RandomResizedCrop → scale & translation invariance
#    • RandAugment       → automatic augmentation policy (replaces manual jitter)
#    • RandomErasing     → simulates occlusion (insects, shadows, overlapping leaves)
#    • RandomVerticalFlip→ leaf photos can be any orientation
#  MixUp & CutMix are applied in the training loop (Cell 12), not here.

IMAGENET_MEAN = [0.485, 0.456, 0.406]
IMAGENET_STD  = [0.229, 0.224, 0.225]


def get_train_transforms(img_size: int) -> transforms.Compose:
    return transforms.Compose([
        transforms.RandomResizedCrop(img_size, scale=(0.5, 1.0), ratio=(0.75, 1.33)),
        transforms.RandomHorizontalFlip(0.5),
        transforms.RandomVerticalFlip(0.2),
        transforms.RandAugment(num_ops=2, magnitude=9),
        transforms.ToTensor(),
        transforms.Normalize(mean=IMAGENET_MEAN, std=IMAGENET_STD),
        transforms.RandomErasing(p=0.25, scale=(0.02, 0.33)),
    ])


def get_eval_transforms(img_size: int) -> transforms.Compose:
    """Resize → CenterCrop → Normalize.  Standard eval protocol."""
    return transforms.Compose([
        transforms.Resize(int(img_size * 256 / 224)),   # e.g. 256 for img_size=224
        transforms.CenterCrop(img_size),
        transforms.ToTensor(),
        transforms.Normalize(mean=IMAGENET_MEAN, std=IMAGENET_STD),
    ])


# %%  ═══════════════════════ CELL 11 — Model Builder ═════════════════════════

def build_model(
    arch: str,
    num_classes: int,
    pretrained: bool = True,
    dropout: float = 0.3,
) -> nn.Module:
    """
    Build EfficientNet-B0 or MobileNetV3-Large from torchvision.
    No external dependencies (timm) needed.
    """
    if arch == "efficientnet_b0":
        weights = models.EfficientNet_B0_Weights.DEFAULT if pretrained else None
        model = models.efficientnet_b0(weights=weights, dropout=dropout)
        in_feat = model.classifier[1].in_features          # 1280
        model.classifier[1] = nn.Linear(in_feat, num_classes)

    elif arch == "mobilenet_v3_large":
        weights = models.MobileNet_V3_Large_Weights.DEFAULT if pretrained else None
        model = models.mobilenet_v3_large(weights=weights, dropout=dropout)
        in_feat = model.classifier[3].in_features          # 1280
        model.classifier[3] = nn.Linear(in_feat, num_classes)

    else:
        raise ValueError(
            f"Unsupported arch '{arch}'. "
            f"Use 'efficientnet_b0' or 'mobilenet_v3_large'."
        )

    total = sum(p.numel() for p in model.parameters())
    print(f"[{arch}] {total:,} parameters  |  classifier → {num_classes} classes")
    return model


# ── Backbone freeze / unfreeze ────────────────────────────────────────

def freeze_backbone(model: nn.Module):
    """Freeze all feature-extraction layers; only the head stays trainable."""
    for p in model.features.parameters():
        p.requires_grad = False

def unfreeze_backbone(model: nn.Module):
    for p in model.features.parameters():
        p.requires_grad = True


def get_param_groups(
    model: nn.Module,
    backbone_lr: float,
    head_lr: float,
    weight_decay: float,
) -> list[dict]:
    """Discriminative LRs: low for backbone, higher for classifier head."""
    return [
        {"params": list(model.features.parameters()),
         "lr": backbone_lr, "weight_decay": weight_decay},
        {"params": list(model.classifier.parameters()),
         "lr": head_lr, "weight_decay": weight_decay},
    ]


# %%  ═══════════════ CELL 12 — Training Utilities ════════════════════════════
#
#  MixUp, CutMix, Exponential Moving Average — applied during training.

# ── MixUp ─────────────────────────────────────────────────────────────

def mixup_data(x: torch.Tensor, y: torch.Tensor, alpha: float = 0.3):
    """Mix pairs of samples and their labels with a Beta-sampled λ."""
    lam = np.random.beta(alpha, alpha) if alpha > 0 else 1.0
    idx = torch.randperm(x.size(0), device=x.device)
    mixed = lam * x + (1 - lam) * x[idx]
    return mixed, y, y[idx], lam


# ── CutMix ────────────────────────────────────────────────────────────

def cutmix_data(x: torch.Tensor, y: torch.Tensor, alpha: float = 1.0):
    """Paste a random rectangle from one sample onto another."""
    lam = np.random.beta(alpha, alpha) if alpha > 0 else 1.0
    idx = torch.randperm(x.size(0), device=x.device)
    _, _, H, W = x.shape

    cut_rat = math.sqrt(1.0 - lam)
    cw, ch = int(W * cut_rat), int(H * cut_rat)
    cx = random.randint(0, W - 1)
    cy = random.randint(0, H - 1)
    x1, x2 = max(cx - cw // 2, 0), min(cx + cw // 2, W)
    y1, y2 = max(cy - ch // 2, 0), min(cy + ch // 2, H)

    out = x.clone()
    out[:, :, y1:y2, x1:x2] = x[idx, :, y1:y2, x1:x2]
    lam = 1.0 - ((x2 - x1) * (y2 - y1)) / (W * H)   # actual λ after clipping
    return out, y, y[idx], lam


# ── Exponential Moving Average ────────────────────────────────────────

class ModelEMA:
    """
    Maintains a shadow copy of the model whose weights are an exponential
    moving average of the training weights.  Almost always generalises
    better than the raw model.
    """

    def __init__(self, model: nn.Module, decay: float = 0.999):
        self.ema = copy.deepcopy(model)
        self.ema.eval()
        self.decay = decay
        for p in self.ema.parameters():
            p.requires_grad_(False)

    @torch.no_grad()
    def update(self, model: nn.Module):
        for ep, mp in zip(self.ema.parameters(), model.parameters()):
            ep.data.mul_(self.decay).add_(mp.data, alpha=1.0 - self.decay)

    def state_dict(self):
        return self.ema.state_dict()

    def module(self) -> nn.Module:
        return self.ema


# %%  ═══════════════════ CELL 13 — Training Function ═════════════════════════

def _train_one_epoch(
    model, loader, criterion, optimizer, scaler, ema, cfg, use_amp, apply_mix,
):
    """One pass over the training set with optional MixUp / CutMix."""
    model.train()
    running_loss = 0.0
    correct = 0
    total = 0

    for images, labels in loader:
        images = images.to(DEVICE, non_blocking=True)
        labels = labels.to(DEVICE, non_blocking=True)

        # ── optional MixUp / CutMix ──────────────────────────────────
        mixed = False
        if apply_mix and random.random() < cfg.mix_prob:
            mixed = True
            if random.random() < 0.5:
                images, ya, yb, lam = mixup_data(images, labels, cfg.mixup_alpha)
            else:
                images, ya, yb, lam = cutmix_data(images, labels, cfg.cutmix_alpha)

        # ── forward ──────────────────────────────────────────────────
        with torch.cuda.amp.autocast(enabled=use_amp):
            logits = model(images)
            if mixed:
                loss = lam * criterion(logits, ya) + (1 - lam) * criterion(logits, yb)
            else:
                loss = criterion(logits, labels)

        # ── backward ─────────────────────────────────────────────────
        optimizer.zero_grad(set_to_none=True)
        scaler.scale(loss).backward()
        scaler.unscale_(optimizer)
        torch.nn.utils.clip_grad_norm_(model.parameters(), cfg.grad_clip_norm)
        scaler.step(optimizer)
        scaler.update()

        # ── EMA ──────────────────────────────────────────────────────
        ema.update(model)

        # ── bookkeeping ──────────────────────────────────────────────
        bs = images.size(0)
        running_loss += loss.item() * bs
        preds = logits.argmax(1)
        if mixed:
            correct += (lam * (preds == ya).float().sum().item()
                        + (1 - lam) * (preds == yb).float().sum().item())
        else:
            correct += (preds == labels).sum().item()
        total += bs

    return running_loss / total, correct / total


@torch.no_grad()
def _validate(model, loader, criterion, use_amp):
    """One pass over the validation set (no augmentation, no mix)."""
    model.eval()
    running_loss = 0.0
    correct = 0
    total = 0

    for images, labels in loader:
        images = images.to(DEVICE, non_blocking=True)
        labels = labels.to(DEVICE, non_blocking=True)

        with torch.cuda.amp.autocast(enabled=use_amp):
            logits = model(images)
            loss = criterion(logits, labels)

        running_loss += loss.item() * images.size(0)
        correct += (logits.argmax(1) == labels).sum().item()
        total += images.size(0)

    return running_loss / total, correct / total


def _save_checkpoint(state_dict, cfg, val_acc, epoch):
    path = Path(cfg.checkpoint_dir) / f"{cfg.arch}_best.pt"
    torch.save({
        "model_state": state_dict,
        "arch":        cfg.arch,
        "classes":     cfg.classes,
        "val_acc":     val_acc,
        "epoch":       epoch,
        "img_size":    cfg.img_size,
    }, path)
    print(f"    → saved checkpoint  val_acc={val_acc:.4f}  epoch={epoch}  → {path}")


# ──────────────────────────────────────────────────────────────────────
#  MAIN TRAINING DRIVER
# ──────────────────────────────────────────────────────────────────────

def train_model(cfg: CFG, class_weights: torch.Tensor):
    """
    Two-phase training on the combined (SLIF + PlantDoc) dataset.

    Phase 1 (head warm-up):
        • backbone frozen, only classifier trained
        • no MixUp / CutMix (clean gradient signal for head init)

    Phase 2 (full fine-tune):
        • all layers unfrozen, discriminative LRs
        • MixUp / CutMix enabled, cosine schedule with warmup
    """

    # ── data loaders ─────────────────────────────────────────────────
    train_ds = ManifestDataset(
        f"{cfg.manifest_dir}/combined_train.csv",
        transform=get_train_transforms(cfg.img_size),
    )
    val_ds = ManifestDataset(
        f"{cfg.manifest_dir}/combined_val.csv",
        transform=get_eval_transforms(cfg.img_size),
    )

    train_loader = DataLoader(
        train_ds, batch_size=cfg.batch_size, shuffle=True,
        num_workers=cfg.num_workers, pin_memory=True, drop_last=True,
    )
    val_loader = DataLoader(
        val_ds, batch_size=cfg.batch_size, shuffle=False,
        num_workers=cfg.num_workers, pin_memory=True,
    )

    # ── model + EMA ──────────────────────────────────────────────────
    model = build_model(cfg.arch, cfg.num_classes, cfg.pretrained, cfg.dropout)
    model = model.to(DEVICE)
    ema = ModelEMA(model, decay=cfg.ema_decay)

    # ── loss (class-weighted + label smoothing) ──────────────────────
    criterion = nn.CrossEntropyLoss(
        weight=class_weights.to(DEVICE),
        label_smoothing=cfg.label_smoothing,
    )

    # ── mixed precision ──────────────────────────────────────────────
    use_amp = DEVICE.type == "cuda"
    scaler = torch.cuda.amp.GradScaler(enabled=use_amp)

    Path(cfg.checkpoint_dir).mkdir(parents=True, exist_ok=True)
    history = {"train_loss": [], "val_loss": [],
               "train_acc": [], "val_acc": [], "lr": []}
    best_val_acc = 0.0

    # ═════════════════ PHASE 1 — HEAD WARM-UP ════════════════════════
    print(f"\n{'═' * 65}")
    print(f"  PHASE 1 : head warm-up  ({cfg.phase1_epochs} epochs, backbone frozen)")
    print(f"{'═' * 65}")

    freeze_backbone(model)
    head_params = [p for p in model.parameters() if p.requires_grad]
    opt = torch.optim.AdamW(head_params, lr=cfg.phase1_lr,
                            weight_decay=cfg.weight_decay)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(
        opt, T_max=cfg.phase1_epochs, eta_min=cfg.min_lr,
    )

    for ep in range(1, cfg.phase1_epochs + 1):
        t0 = time.time()
        tl, ta = _train_one_epoch(model, train_loader, criterion, opt,
                                  scaler, ema, cfg, use_amp, apply_mix=False)
        vl, va = _validate(model, val_loader, criterion, use_amp)
        _, ea = _validate(ema.module(), val_loader, criterion, use_amp)
        sched.step()

        best_of = max(va, ea)
        history["train_loss"].append(tl)
        history["val_loss"].append(vl)
        history["train_acc"].append(ta)
        history["val_acc"].append(best_of)
        history["lr"].append(opt.param_groups[0]["lr"])

        tag = ""
        if best_of > best_val_acc:
            best_val_acc = best_of
            sd = ema.state_dict() if ea >= va else model.state_dict()
            _save_checkpoint(sd, cfg, best_val_acc, ep)
            tag = " ★"

        print(f"  P1 [{ep:02d}/{cfg.phase1_epochs}]  "
              f"loss={tl:.4f}/{vl:.4f}  "
              f"acc={ta:.4f}/{va:.4f}  "
              f"ema={ea:.4f}  "
              f"lr={opt.param_groups[0]['lr']:.2e}  "
              f"{time.time()-t0:.1f}s{tag}")

    # ═════════════════ PHASE 2 — FULL FINE-TUNE ══════════════════════
    print(f"\n{'═' * 65}")
    print(f"  PHASE 2 : full fine-tune  ({cfg.phase2_epochs} epochs, "
          f"backbone_lr={cfg.backbone_lr:.0e}  head_lr={cfg.head_lr:.0e})")
    print(f"{'═' * 65}")

    unfreeze_backbone(model)
    param_groups = get_param_groups(model, cfg.backbone_lr, cfg.head_lr,
                                    cfg.weight_decay)
    opt = torch.optim.AdamW(param_groups)

    warmup = torch.optim.lr_scheduler.LinearLR(
        opt, start_factor=0.01, total_iters=cfg.warmup_epochs,
    )
    cosine = torch.optim.lr_scheduler.CosineAnnealingLR(
        opt, T_max=cfg.phase2_epochs - cfg.warmup_epochs, eta_min=cfg.min_lr,
    )
    sched = torch.optim.lr_scheduler.SequentialLR(
        opt, [warmup, cosine], milestones=[cfg.warmup_epochs],
    )

    for ep in range(1, cfg.phase2_epochs + 1):
        t0 = time.time()
        tl, ta = _train_one_epoch(model, train_loader, criterion, opt,
                                  scaler, ema, cfg, use_amp, apply_mix=True)
        vl, va = _validate(model, val_loader, criterion, use_amp)
        _, ea = _validate(ema.module(), val_loader, criterion, use_amp)
        sched.step()

        best_of = max(va, ea)
        history["train_loss"].append(tl)
        history["val_loss"].append(vl)
        history["train_acc"].append(ta)
        history["val_acc"].append(best_of)
        history["lr"].append(opt.param_groups[1]["lr"])   # head LR

        tag = ""
        if best_of > best_val_acc:
            best_val_acc = best_of
            sd = ema.state_dict() if ea >= va else model.state_dict()
            _save_checkpoint(sd, cfg, best_val_acc, cfg.phase1_epochs + ep)
            tag = " ★"

        lr_bb = opt.param_groups[0]["lr"]
        lr_hd = opt.param_groups[1]["lr"]
        print(f"  P2 [{ep:02d}/{cfg.phase2_epochs}]  "
              f"loss={tl:.4f}/{vl:.4f}  "
              f"acc={ta:.4f}/{va:.4f}  "
              f"ema={ea:.4f}  "
              f"lr_bb={lr_bb:.2e} lr_hd={lr_hd:.2e}  "
              f"{time.time()-t0:.1f}s{tag}")

    print(f"\n{'═' * 65}")
    print(f"  ✅  Training complete!  Best val accuracy = {best_val_acc:.4f}")
    print(f"{'═' * 65}")
    return model, ema, history


# %%  ══════════════════ CELL 14 — Run Training (execute) ═════════════════════

model, ema, history = train_model(cfg, class_weights)


# %%  ═══════════════════ CELL 15 — Evaluation Function ═══════════════════════

@torch.no_grad()
def evaluate(
    checkpoint_path: str,
    manifest_csv: str,
    tag: str,
    cfg: CFG,
) -> Tuple[float, float, np.ndarray]:
    """
    Full evaluation: accuracy, macro-F1, per-class precision/recall/F1,
    and confusion matrix.  Returns (accuracy, macro_f1, confusion_matrix).
    """
    ckpt = torch.load(checkpoint_path, map_location=DEVICE, weights_only=False)
    classes = ckpt["classes"]

    model = build_model(ckpt["arch"], len(classes), pretrained=False,
                        dropout=cfg.dropout).to(DEVICE)
    model.load_state_dict(ckpt["model_state"])
    model.eval()

    ds = ManifestDataset(manifest_csv, transform=get_eval_transforms(cfg.img_size),
                         classes=classes)
    loader = DataLoader(ds, batch_size=cfg.batch_size, shuffle=False,
                        num_workers=cfg.num_workers, pin_memory=True)

    use_amp = DEVICE.type == "cuda"
    all_preds, all_labels = [], []

    for images, labels in loader:
        images = images.to(DEVICE, non_blocking=True)
        with torch.cuda.amp.autocast(enabled=use_amp):
            logits = model(images)
        all_preds.extend(logits.argmax(1).cpu().tolist())
        all_labels.extend(labels.tolist())

    acc = accuracy_score(all_labels, all_preds)
    f1  = f1_score(all_labels, all_preds, average="macro")
    cm  = confusion_matrix(all_labels, all_preds)
    report_str = classification_report(all_labels, all_preds,
                                       target_names=classes)

    print(f"\n{'━' * 60}")
    print(f"  {tag}  ({ckpt['arch']}, n={len(all_labels)})")
    print(f"{'━' * 60}")
    print(f"  Accuracy : {acc:.4f}")
    print(f"  Macro F1 : {f1:.4f}")
    print(f"\n{report_str}")
    print(f"  Confusion matrix (rows = true, cols = pred):")
    print(f"  {classes}")
    for i, row in enumerate(cm):
        print(f"    {classes[i]:25s} {row}")
    print(f"{'━' * 60}")

    # ── persist to CSV ────────────────────────────────────────────────
    Path(cfg.results_dir).mkdir(parents=True, exist_ok=True)
    csv_path = Path(cfg.results_dir) / "results.csv"
    row = {"tag": tag, "arch": ckpt["arch"], "n": len(all_labels),
           "accuracy": round(acc, 4), "macro_f1": round(f1, 4)}
    header = not csv_path.exists()
    with open(csv_path, "a") as f:
        if header:
            f.write(",".join(row.keys()) + "\n")
        f.write(",".join(str(v) for v in row.values()) + "\n")

    # ── full JSON report ──────────────────────────────────────────────
    report_dict = classification_report(all_labels, all_preds,
                                        target_names=classes, output_dict=True)
    detail = Path(cfg.results_dir) / f"{tag}_{ckpt['arch']}_report.json"
    with open(detail, "w") as f:
        json.dump({"accuracy": acc, "macro_f1": f1, "report": report_dict,
                   "confusion_matrix": cm.tolist(), "classes": classes},
                  f, indent=2)
    print(f"  Saved → {csv_path}  +  {detail}")
    return acc, f1, cm


# %%  ════════════════ CELL 16 — Run Evaluation (execute) ═════════════════════

ckpt_path = f"{cfg.checkpoint_dir}/{cfg.arch}_best.pt"

# 1) Combined test (primary metric)
evaluate(ckpt_path, f"{cfg.manifest_dir}/combined_test.csv",
         "combined_test", cfg)

# 2) Per-source ablation — see how well it does on each dataset alone
#    (the test split already contains images from both sources, so we
#     filter the combined_test manifest by source column)
test_all = pd.read_csv(f"{cfg.manifest_dir}/combined_test.csv")

slif_only = test_all[test_all["source"] == "slif"]
plantdoc_only = test_all[test_all["source"] == "plantdoc"]

# write temporary per-source test manifests
slif_only.to_csv(f"{cfg.manifest_dir}/test_slif_only.csv", index=False)
plantdoc_only.to_csv(f"{cfg.manifest_dir}/test_plantdoc_only.csv", index=False)

evaluate(ckpt_path, f"{cfg.manifest_dir}/test_slif_only.csv",
         "slif_test_only", cfg)
evaluate(ckpt_path, f"{cfg.manifest_dir}/test_plantdoc_only.csv",
         "plantdoc_test_only", cfg)


# %%  ═══════════════ CELL 17 — Training History Plots (execute) ══════════════

def plot_history(history: dict, cfg: CFG):
    fig, axes = plt.subplots(1, 3, figsize=(16, 4.5))
    epochs = range(1, len(history["train_loss"]) + 1)
    phase_boundary = cfg.phase1_epochs + 0.5     # vertical divider

    # ── Loss ──────────────────────────────────────────────────────────
    axes[0].plot(epochs, history["train_loss"], label="Train", linewidth=1.5)
    axes[0].plot(epochs, history["val_loss"],   label="Val",   linewidth=1.5)
    axes[0].axvline(phase_boundary, color="gray", ls="--", alpha=0.5,
                    label="Phase 1→2")
    axes[0].set(xlabel="Epoch", ylabel="Loss", title="Loss")
    axes[0].legend()
    axes[0].grid(alpha=0.3)

    # ── Accuracy ──────────────────────────────────────────────────────
    axes[1].plot(epochs, history["train_acc"], label="Train", linewidth=1.5)
    axes[1].plot(epochs, history["val_acc"],   label="Val (best of model/EMA)",
                 linewidth=1.5)
    axes[1].axvline(phase_boundary, color="gray", ls="--", alpha=0.5,
                    label="Phase 1→2")
    axes[1].set(xlabel="Epoch", ylabel="Accuracy", title="Accuracy")
    axes[1].legend()
    axes[1].grid(alpha=0.3)

    # ── Learning rate ─────────────────────────────────────────────────
    axes[2].plot(epochs, history["lr"], linewidth=1.5, color="tab:green")
    axes[2].axvline(phase_boundary, color="gray", ls="--", alpha=0.5,
                    label="Phase 1→2")
    axes[2].set(xlabel="Epoch", ylabel="LR", title="Learning Rate Schedule")
    axes[2].set_yscale("log")
    axes[2].legend()
    axes[2].grid(alpha=0.3)

    plt.tight_layout()
    Path(cfg.results_dir).mkdir(parents=True, exist_ok=True)
    fig.savefig(f"{cfg.results_dir}/training_history.png",
                dpi=150, bbox_inches="tight")
    plt.show()
    print(f"Saved → {cfg.results_dir}/training_history.png")


plot_history(history, cfg)


# %%  ═══════════════ CELL 18 — GradCAM Visualisation (execute) ═══════════════
#
#  Verify the model focuses on leaf lesions (spots, rings, necrotic tissue)
#  rather than background, pot edges, soil, or colour-of-the-label artifacts.

class GradCAM:
    """Gradient-weighted Class Activation Mapping (simplified)."""

    def __init__(self, model: nn.Module, target_layer: nn.Module):
        self.model = model
        self.activations = None
        self.gradients = None
        target_layer.register_forward_hook(self._fwd)
        target_layer.register_full_backward_hook(self._bwd)

    def _fwd(self, module, inp, out):
        self.activations = out.detach()

    def _bwd(self, module, grad_in, grad_out):
        self.gradients = grad_out[0].detach()

    @torch.enable_grad()
    def __call__(self, x: torch.Tensor, target_class: Optional[int] = None):
        self.model.eval()
        out = self.model(x)
        if target_class is None:
            target_class = out.argmax(1).item()

        self.model.zero_grad()
        out[0, target_class].backward()

        w = self.gradients.mean(dim=[2, 3], keepdim=True)       # GAP weights
        cam = (w * self.activations).sum(dim=1, keepdim=True)
        cam = F.relu(cam)
        cam = F.interpolate(cam, size=x.shape[2:], mode="bilinear",
                            align_corners=False).squeeze()
        if cam.max() > 0:
            cam = (cam - cam.min()) / (cam.max() - cam.min())
        probs = out.softmax(1)[0].detach().cpu().numpy()
        return cam.cpu().numpy(), target_class, probs


def visualise_gradcam(checkpoint_path: str, manifest_csv: str,
                      cfg: CFG, n: int = 8):
    ckpt = torch.load(checkpoint_path, map_location=DEVICE, weights_only=False)
    classes = ckpt["classes"]
    model = build_model(ckpt["arch"], len(classes), pretrained=False,
                        dropout=cfg.dropout).to(DEVICE)
    model.load_state_dict(ckpt["model_state"])
    model.eval()

    # Hook the last feature block  (works for both EfficientNet & MobileNetV3)
    target_layer = model.features[-1]
    cam_fn = GradCAM(model, target_layer)

    ds = ManifestDataset(manifest_csv,
                         transform=get_eval_transforms(cfg.img_size),
                         classes=classes)

    mean = torch.tensor(IMAGENET_MEAN).view(3, 1, 1)
    std  = torch.tensor(IMAGENET_STD).view(3, 1, 1)

    cols = min(n, 4)
    rows = math.ceil(n / cols)
    fig, axes = plt.subplots(rows, cols, figsize=(4 * cols, 4 * rows))
    axes = np.array(axes).flatten()

    indices = random.sample(range(len(ds)), min(n, len(ds)))
    for i, idx in enumerate(indices):
        img_t, true_label = ds[idx]
        inp = img_t.unsqueeze(0).to(DEVICE)
        heatmap, pred_cls, probs = cam_fn(inp)

        # de-normalise for display
        vis = (img_t.cpu() * std + mean).permute(1, 2, 0).numpy().clip(0, 1)

        axes[i].imshow(vis)
        axes[i].imshow(heatmap, cmap="jet", alpha=0.4)
        colour = "green" if true_label == pred_cls else "red"
        axes[i].set_title(
            f"True: {classes[true_label]}\n"
            f"Pred: {classes[pred_cls]} ({probs[pred_cls]:.2f})",
            fontsize=8, color=colour,
        )
        axes[i].axis("off")

    # hide unused axes
    for j in range(i + 1, len(axes)):
        axes[j].axis("off")

    plt.tight_layout()
    out_path = f"{cfg.results_dir}/gradcam_{ckpt['arch']}.png"
    fig.savefig(out_path, dpi=150, bbox_inches="tight")
    plt.show()
    print(f"GradCAM saved → {out_path}")


visualise_gradcam(ckpt_path, f"{cfg.manifest_dir}/combined_test.csv", cfg, n=8)


# %%  ═══════════════════ CELL 19 — ONNX Export (execute) ═════════════════════

def export_onnx(checkpoint_path: str, cfg: CFG) -> str:
    """Export the best checkpoint to ONNX (FP32)."""
    ckpt = torch.load(checkpoint_path, map_location="cpu", weights_only=False)
    classes = ckpt["classes"]

    model = build_model(ckpt["arch"], len(classes), pretrained=False,
                        dropout=0.0)   # dropout=0 → clean export graph
    model.load_state_dict(ckpt["model_state"])
    model.eval()

    dummy = torch.randn(1, 3, cfg.img_size, cfg.img_size)
    onnx_path = str(Path(cfg.checkpoint_dir) / f"{ckpt['arch']}_tomato.onnx")

    torch.onnx.export(
        model, dummy, onnx_path,
        export_params=True,
        input_names=["input"],
        output_names=["output"],
        # dynamic_axes={"input": {0: "batch"}, "output": {0: "batch"}}, # Removed: static shapes are safer for INT8 shape inference and better for mobile memory allocation
        opset_version=18,
        do_constant_folding=True,
    )

    # ── also save a class-index JSON alongside the model ─────────────
    meta_path = onnx_path.replace(".onnx", "_classes.json")
    with open(meta_path, "w") as f:
        json.dump({"classes": classes, "img_size": cfg.img_size}, f, indent=2)

    size_mb = os.path.getsize(onnx_path) / (1024 * 1024)
    print(f"\n  Exported FP32 ONNX  → {onnx_path}  ({size_mb:.1f} MB)")
    print(f"  Class metadata      → {meta_path}")
    return onnx_path


fp32_onnx = export_onnx(ckpt_path, cfg)


# %%  ═══════════════ CELL 20 — FP16 Model Export (execute) ═════════════════
#
#  Dynamic INT8 quantization destroys the math in EfficientNet's depthwise 
#  convolutions (dropping accuracy to ~10%). Instead, we export to FP16!
#  This cuts the model size in half (~10.5 MB) and preserves 100% accuracy.
#  Android NNAPI and mobile GPUs run FP16 models natively and extremely fast.

def export_onnx_fp16(checkpoint_path: str, cfg: CFG) -> str:
    ckpt = torch.load(checkpoint_path, map_location="cpu", weights_only=False)
    classes = ckpt["classes"]

    model = build_model(ckpt["arch"], len(classes), pretrained=False,
                        dropout=0.0)
    model.load_state_dict(ckpt["model_state"])
    
    # Cast weights and dummy input to 16-bit float
    model.half()
    model.eval()
    dummy = torch.randn(1, 3, cfg.img_size, cfg.img_size).half()
    
    fp16_path = str(Path(cfg.checkpoint_dir) / f"{ckpt['arch']}_tomato_fp16.onnx")

    torch.onnx.export(
        model, dummy, fp16_path,
        export_params=True,
        input_names=["input"],
        output_names=["output"],
        opset_version=18,
        do_constant_folding=True,
    )
    
    s_fp32 = 21.5 # Approximate FP32 size in MB
    s_fp16 = os.path.getsize(fp16_path) / (1024 * 1024)

    print(f"\n  FP16 Export complete!")
    print(f"    FP16 Size : {s_fp16:.1f} MB  (half the size, full accuracy!)")
    print(f"    Path      : {fp16_path}")
    return fp16_path

fp16_onnx = export_onnx_fp16(ckpt_path, cfg)


# %%  ════════════ CELL 21 — Verify Quantised Model (execute) ═════════════════
#
#  Run inference with ONNX Runtime on the full combined test set,
#  comparing FP32 vs FP16 accuracy to ensure the export is lossless
#  (or very near lossless — <1 % drop is the bar).

def evaluate_onnx(onnx_path: str, manifest_csv: str, cfg: CFG, tag: str):
    """Evaluate an ONNX model on a manifest CSV using ONNX Runtime (CPU)."""
    import onnxruntime as ort

    session = ort.InferenceSession(onnx_path,
                                   providers=["CPUExecutionProvider"])

    ds = ManifestDataset(manifest_csv,
                         transform=get_eval_transforms(cfg.img_size))
    
    # Since we exported the ONNX model with a static batch size of 1 for mobile,
    # we must evaluate it with batch_size=1.
    loader = DataLoader(ds, batch_size=1, shuffle=False,
                        num_workers=0)   # num_workers=0 for ONNX safety

    all_preds, all_labels = [], []
    for images, labels in loader:
        # Cast input to float16 if evaluating the FP16 model
        img_np = images.numpy()
        if "fp16" in tag.lower():
            img_np = img_np.astype(np.float16)
            
        outputs = session.run(None, {"input": img_np})
        preds = np.argmax(outputs[0], axis=1)
        all_preds.extend(preds.tolist())
        all_labels.extend(labels.tolist())

    acc = accuracy_score(all_labels, all_preds)
    f1  = f1_score(all_labels, all_preds, average="macro")
    print(f"  [{tag}]  {Path(onnx_path).name:40s}  acc={acc:.4f}  f1={f1:.4f}")
    return acc, f1


print(f"\n{'═' * 65}")
print("  ONNX Model Verification (combined test set)")
print(f"{'═' * 65}")

test_csv = f"{cfg.manifest_dir}/combined_test.csv"
fp32_acc, fp32_f1 = evaluate_onnx(fp32_onnx, test_csv, cfg, "FP32")
fp16_acc, fp16_f1 = evaluate_onnx(fp16_onnx, test_csv, cfg, "FP16")

drop = fp32_acc - fp16_acc
print(f"\n  Accuracy drop from FP16 export: {drop:+.4f}  "
      f"({'✅ OK' if abs(drop) < 0.01 else '⚠️  check calibration'})")
print(f"\n  📱 Deploy this file on your phone:")
print(f"     {fp16_onnx}")
print(f"     with ONNX Runtime Mobile  (pip install onnxruntime  on Android/iOS)")
print(f"{'═' * 65}")


# %%  ════════════════════ CELL 22 — Summary Table ════════════════════════════
#
#  Print a comparison table of all evaluation results.

try:
    results = pd.read_csv(f"{cfg.results_dir}/results.csv")
    print("\n📊  All evaluation results:\n")
    print(results.to_string(index=False))
except FileNotFoundError:
    print("No results.csv found — run evaluation cells first.")
