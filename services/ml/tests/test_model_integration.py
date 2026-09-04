import os
from pathlib import Path

import numpy as np
import pytest

from app.engine import ModelSuite
from app.integrity import verify_model_package


@pytest.mark.models
@pytest.mark.skipif(not os.getenv("MODEL_ROOT"), reason="MODEL_ROOT no configurado")
def test_verified_models_load_and_ensemble_is_exactly_half_each():
    root = Path(os.environ["MODEL_ROOT"])
    verify_model_package(root)
    suite = ModelSuite(root, "cpu")
    axis = np.linspace(0, 1, 384, dtype=np.float32)
    roi = np.outer(axis, axis[::-1]).astype(np.float32)
    result = suite.kl.predict(roi)
    ensemble = np.asarray(list(result["probabilities"].values()))
    resnet = np.asarray(list(result["member_probabilities"]["resnet50"].values()))
    densenet = np.asarray(list(result["member_probabilities"]["densenet121"].values()))
    np.testing.assert_allclose(ensemble, (resnet + densenet) / 2, atol=1e-6)
    assert ensemble.sum() == pytest.approx(1.0, abs=1e-6)

