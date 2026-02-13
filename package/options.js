// Default settings
const DEFAULTS = {
  colorStops: ['#713071', '#0c4ae0', '#28eaed', '#24ca26', '#f1f060', '#d90916', '#430102'],
  distance: 7,
  toggleKey: 'g',
};

// Last saved settings (to track modifications)
let savedSettings = null;

// Get current settings from the form
function getCurrentSettings() {
  const colorStops = [];
  for (let i = 0; i < 7; i++) {
    colorStops.push(document.getElementById('color' + i).value.toLowerCase());
  }
  const distance = parseFloat(document.getElementById('distance').value) || 7;
  const toggleKey = document.getElementById('toggleKey').value.toLowerCase() || 'g';
  return { colorStops, distance, toggleKey };
}

// Compare two settings objects
function settingsEqual(a, b) {
  if (a.distance !== b.distance) return false;
  if (a.toggleKey !== b.toggleKey) return false;
  for (let i = 0; i < 7; i++) {
    if (a.colorStops[i].toLowerCase() !== b.colorStops[i].toLowerCase()) return false;
  }
  return true;
}

// Update button states based on current settings
function updateButtonStates() {
  const current = getCurrentSettings();
  const saveBtn = document.getElementById('save');
  const resetBtn = document.getElementById('reset');

  // Save button: disabled if no changes since last save
  const hasChanges = !savedSettings || !settingsEqual(current, savedSettings);
  saveBtn.disabled = !hasChanges;
  saveBtn.classList.toggle('disabled', !hasChanges);

  // Reset button: highlighted if current differs from defaults
  const isDefault = settingsEqual(current, DEFAULTS);
  resetBtn.classList.toggle('primary', !isDefault);
  resetBtn.classList.toggle('secondary', isDefault);
}

// Load settings from storage
function loadSettings() {
  chrome.storage.sync.get(DEFAULTS, function (settings) {
    for (let i = 0; i < 7; i++) {
      document.getElementById('color' + i).value = settings.colorStops[i];
    }
    document.getElementById('distance').value = settings.distance;
    document.getElementById('toggleKey').value = settings.toggleKey;
    savedSettings = {
      colorStops: settings.colorStops.map(c => c.toLowerCase()),
      distance: settings.distance,
      toggleKey: settings.toggleKey,
    };
    updatePreview();
    updateLabels(settings.distance);
    updateButtonStates();
  });
}

// Save settings to storage
function saveSettings() {
  const current = getCurrentSettings();

  chrome.storage.sync.set(current, function () {
    savedSettings = current;
    showStatus('Settings saved');
    updateLabels(current.distance);
    updateButtonStates();
  });
}

// Reset form to defaults (does not save until Save is clicked)
function resetSettings() {
  for (let i = 0; i < 7; i++) {
    document.getElementById('color' + i).value = DEFAULTS.colorStops[i];
  }
  document.getElementById('distance').value = DEFAULTS.distance;
  document.getElementById('toggleKey').value = DEFAULTS.toggleKey;
  updatePreview();
  updateLabels(DEFAULTS.distance);
  updateButtonStates();
  showStatus('Reset to defaults (click Save to apply)');
}

// Show status message
function showStatus(message) {
  const status = document.getElementById('status');
  status.textContent = message;
  setTimeout(function () {
    status.textContent = '';
  }, 2000);
}

// Linear interpolation between two hex colors
function lerpColor(color1, color2, t) {
  const r1 = parseInt(color1.slice(1, 3), 16);
  const g1 = parseInt(color1.slice(3, 5), 16);
  const b1 = parseInt(color1.slice(5, 7), 16);

  const r2 = parseInt(color2.slice(1, 3), 16);
  const g2 = parseInt(color2.slice(3, 5), 16);
  const b2 = parseInt(color2.slice(5, 7), 16);

  const r = Math.round(r1 + (r2 - r1) * t);
  const g = Math.round(g1 + (g2 - g1) * t);
  const b = Math.round(b1 + (b2 - b1) * t);

  return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
}

// Update preview bar with interpolated gradient
function updatePreview() {
  const preview = document.getElementById('preview');
  preview.innerHTML = '';

  const colorStops = [];
  for (let i = 0; i < 7; i++) {
    colorStops.push(document.getElementById('color' + i).value);
  }

  // Create 60 segments for smooth gradient (10 per color band)
  const segments = 60;
  for (let i = 0; i < segments; i++) {
    // Map segment index to position in color stops (0-6)
    const pos = (i / segments) * 6;
    const band = Math.min(5, Math.floor(pos));
    const t = pos - band;

    const color = lerpColor(colorStops[band], colorStops[band + 1], t);

    const segment = document.createElement('div');
    segment.className = 'preview-segment';
    segment.style.backgroundColor = color;
    preview.appendChild(segment);
  }
}

// Update labels based on distance
function updateLabels(distance) {
  const d = distance;
  const labels = [`-${d * 3}%`, `-${d * 2}%`, `-${d}%`, `0%`, `+${d}%`, `+${d * 2}%`, `+${d * 3}%`];
  for (let i = 0; i < 7; i++) {
    const row = document.getElementById('color' + i).parentElement;
    row.querySelector('label').textContent = labels[i];
  }
}

// Initialize
document.addEventListener('DOMContentLoaded', loadSettings);

document.getElementById('save').addEventListener('click', saveSettings);
document.getElementById('reset').addEventListener('click', resetSettings);

// Update preview and button states on color change
for (let i = 0; i < 7; i++) {
  document.getElementById('color' + i).addEventListener('input', function () {
    updatePreview();
    updateButtonStates();
  });
}

// Update labels and button states on distance change
document.getElementById('distance').addEventListener('input', function () {
  updateLabels(parseFloat(this.value) || 7);
  updateButtonStates();
});

// Update button states on toggle key change
document.getElementById('toggleKey').addEventListener('input', function () {
  updateButtonStates();
});
