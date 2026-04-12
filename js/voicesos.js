/**
 * SATHI VOICE SOS ENGINE
 * ─────────────────────────────────────────────────────────────────────────
 * Battery-optimized wake-word detection using the Web Speech API.
 *
 * Strategy: Continuous Listening
 *   • Mic is always on during navigation for maximum safety.
 *   • Automatically restarts if the browser speech engine pauses.
 *
 * Matching sensitivity levels:
 *   low    → exact phrase match only
 *   medium → transcript must *contain* the phrase
 *   high   → ≥ 70% of phrase words appear anywhere in transcript
 *
 * Privacy:
 *   Chrome routes audio through Google's STT for transcription.
 *   Sathi itself never receives, stores, or transmits audio.
 * ─────────────────────────────────────────────────────────────────────────
 */

'use strict';

(function (global) {

  // ── Constants ────────────────────────────────────────────────────────
  const LS_KEYS = {
    phrase:      'sathi_voice_phrase',
    enabled:     'sathi_voice_enabled',
    navOnly:     'sathi_voice_nav_only',
    sensitivity: 'sathi_voice_sensitivity',
  };

  // ── Internal state ───────────────────────────────────────────────────
  let _phrase       = 'Help Me';
  let _enabled      = false;
  let _navOnly      = true;
  let _sensitivity  = 'medium';

  let _recognition  = null;
  let _isListening  = false;
  let _supported    = false;

  // ── Private helpers ──────────────────────────────────────────────────

  function _normalize(str) {
    return str.toLowerCase().trim().replace(/[^\w\s]/g, '');
  }

  function _matches(transcript) {
    const t = _normalize(transcript);
    const p = _normalize(_phrase);

    if (_sensitivity === 'low') {
      return t === p;
    }
    if (_sensitivity === 'medium') {
      return t.includes(p);
    }
    // high: fuzzy — 70% of phrase words must appear in transcript
    const phraseWords = p.split(/\s+/).filter(Boolean);
    const transcriptWords = t.split(/\s+/).filter(Boolean);
    if (phraseWords.length === 0) return false;
    const matched = phraseWords.filter(w => transcriptWords.includes(w)).length;
    return matched / phraseWords.length >= 0.7;
  }

  function _updateStatusBadge(state) {
    // state: 'listening' | 'resting' | 'off'
    const badge = document.getElementById('voice-status-badge');
    if (!badge) return;
    const labels = { listening: '🎤 Listening', off: '🎤 Off' };
    const colors = { listening: '#22C55E', off: '#8B91A8' };
    badge.textContent = labels[state] || '';
    badge.style.background = colors[state] || 'transparent';
    badge.style.display = state === 'off' ? 'none' : 'inline-flex';
  }

  function _updateMicAnimation(active) {
    const anim = document.getElementById('mic-anim');
    if (!anim) return;
    anim.classList.toggle('active', active);
  }

  function _buildRecognition() {
    const SpeechRecognition = global.SpeechRecognition || global.webkitSpeechRecognition;
    if (!SpeechRecognition) return null;

    const r = new SpeechRecognition();
    r.continuous     = true;
    r.interimResults = false;
    r.lang           = 'en-IN';
    r.maxAlternatives = 3;

    r.onresult = (event) => {
      for (let i = 0; i < event.results.length; i++) {
        for (let j = 0; j < event.results[i].length; j++) {
          const text = event.results[i][j].transcript;
          console.log('[VoiceSOS] Heard:', text);
          if (_matches(text)) {
            _triggerSOS(text);
            return;
          }
        }
      }
    };

    r.onerror = (e) => {
      // 'no-speech' and 'aborted' are expected — suppress them silently
      if (!['no-speech', 'aborted', 'not-allowed'].includes(e.error)) {
        console.warn('[VoiceSOS] Recognition error:', e.error);
      }
      _isListening = false;
      _updateMicAnimation(false);
    };

    r.onend = () => {
      _isListening = false;
      _updateMicAnimation(false);
      // Restart immediately for continuous listening
      if (_enabled && !document.hidden) {
        _startListening();
      } else {
        _updateStatusBadge('off');
      }
    };

    return r;
  }

  function _startListening() {
    if (!_enabled || !_recognition) return;
    if (document.hidden) {
      // Page is background — defer until visible again
      _updateStatusBadge('off');
      return;
    }
    try {
      _recognition.start();
      _isListening = true;
      _updateStatusBadge('listening');
      _updateMicAnimation(true);
    } catch (e) {
      // Recognition already running (race condition)
    }
  }

  function _triggerSOS(detectedText) {
    console.log('[VoiceSOS] 🚨 Wake phrase detected:', detectedText);
    _pause(); // stop listening immediately
    _updateStatusBadge('off');

    // Delegate to app.js SOS handler
    if (typeof global.triggerVoiceSOS === 'function') {
      global.triggerVoiceSOS(detectedText);
    } else if (typeof global.triggerSOS === 'function') {
      global.triggerSOS('voice_sos');
    }
  }

  function _pause() {
    if (_isListening) {
      try { _recognition.stop(); } catch (_) {}
      _isListening = false;
    }
  }

  // ── Page visibility handler — pause when tab is hidden ───────────────
  document.addEventListener('visibilitychange', () => {
    if (!_enabled) return;
    if (document.hidden) {
      _pause();
      _updateStatusBadge('off');
    } else {
      // Resume continuous listening when user returns to page
      setTimeout(_startListening, 500);
    }
  });

  // ── Public API ───────────────────────────────────────────────────────
  const VoiceSOS = {

    get isSupported() { return _supported; },
    get isEnabled()   { return _enabled; },
    get phrase()      { return _phrase; },
    get sensitivity() { return _sensitivity; },
    get navOnly()     { return _navOnly; },

    /** Load settings from localStorage and check browser support. */
    init() {
      const SpeechRec = global.SpeechRecognition || global.webkitSpeechRecognition;
      _supported = !!SpeechRec;

      if (localStorage.getItem(LS_KEYS.phrase))      _phrase      = localStorage.getItem(LS_KEYS.phrase);
      if (localStorage.getItem(LS_KEYS.enabled))     _enabled     = localStorage.getItem(LS_KEYS.enabled) === 'true';
      if (localStorage.getItem(LS_KEYS.navOnly))     _navOnly     = localStorage.getItem(LS_KEYS.navOnly) !== 'false';
      if (localStorage.getItem(LS_KEYS.sensitivity)) _sensitivity = localStorage.getItem(LS_KEYS.sensitivity);

      if (_supported) {
        _recognition = _buildRecognition();
      }

      // Sync UI toggles on load
      this._syncUI();
      console.log('[VoiceSOS] Initialized. Supported:', _supported, '| Phrase:', _phrase);
    },

    /** Start burst-listen cycle. */
    enable() {
      if (!_supported) {
        console.warn('[VoiceSOS] SpeechRecognition not supported in this browser.');
        return;
      }
      _enabled = true;
      localStorage.setItem(LS_KEYS.enabled, 'true');
      if (!_recognition) _recognition = _buildRecognition();
      _startListening();
      this._syncUI();
    },

    /** Stop all timers and recognition. */
    disable() {
      _enabled = false;
      localStorage.setItem(LS_KEYS.enabled, 'false');
      _pause();
      _updateStatusBadge('off');
      _updateMicAnimation(false);
      this._syncUI();
    },

    /** Save a new wake phrase. */
    setPhrase(phrase) {
      if (!phrase || !phrase.trim()) return false;
      _phrase = phrase.trim();
      localStorage.setItem(LS_KEYS.phrase, _phrase);
      this._syncUI();
      return true;
    },

    /** Save sensitivity level. */
    setSensitivity(level) {
      _sensitivity = level;
      localStorage.setItem(LS_KEYS.sensitivity, level);
    },

    /** Save nav-only setting. */
    setNavOnly(val) {
      _navOnly = val;
      localStorage.setItem(LS_KEYS.navOnly, val ? 'true' : 'false');
    },

    /**
     * Test phrase detection: listens for up to 5s.
     * @param {function} callback - called with { matched: bool, heard: string }
     */
    testPhrase(callback) {
      if (!_supported) {
        callback({ matched: false, heard: '', unsupported: true });
        return;
      }
      _pause(); // Stop any active cycle first

      const SpeechRec = global.SpeechRecognition || global.webkitSpeechRecognition;
      const testRec = new SpeechRec();
      testRec.continuous     = false;
      testRec.interimResults = false;
      testRec.lang           = 'en-IN';
      testRec.maxAlternatives = 3;

      let resolved = false;

      testRec.onresult = (event) => {
        for (let i = 0; i < event.results.length; i++) {
          for (let j = 0; j < event.results[i].length; j++) {
            const text = event.results[i][j].transcript;
            if (!resolved) {
              resolved = true;
              callback({ matched: _matches(text), heard: text });
            }
            return;
          }
        }
      };

      testRec.onerror = (e) => {
        if (!resolved) {
          resolved = true;
          callback({ matched: false, heard: '', error: e.error });
        }
      };

      testRec.onend = () => {
        if (!resolved) {
          resolved = true;
          callback({ matched: false, heard: '', error: 'no-speech' });
        }
        // Resume listening if it was active
        if (_enabled) {
          setTimeout(_startListening, 500);
        }
      };

      try {
        testRec.start();
      } catch (e) {
        callback({ matched: false, heard: '', error: e.message });
      }
    },

    /** Sync all UI elements to current state. */
    _syncUI() {
      const voiceToggle = document.getElementById('voice-toggle');
      if (voiceToggle) voiceToggle.classList.toggle('active', _enabled);

      const navVoiceToggle = document.getElementById('nav-voice-toggle');
      if (navVoiceToggle) navVoiceToggle.classList.toggle('active', _enabled);

      const phraseDisplay = document.getElementById('saved-phrase-text');
      if (phraseDisplay) phraseDisplay.textContent = `"${_phrase}"`;

      const voicePrompt = document.querySelector('.voice-prompt');
      if (voicePrompt) voicePrompt.innerHTML = `Say <strong>"${_phrase}"</strong> to trigger SOS`;

      const navOnlyToggle = document.getElementById('nav-only-toggle');
      if (navOnlyToggle) navOnlyToggle.classList.toggle('active', _navOnly);

      const sensitivitySelect = document.getElementById('voice-sensitivity');
      if (sensitivitySelect) sensitivitySelect.value = _sensitivity;

      const phraseInput = document.getElementById('wake-phrase-input');
      if (phraseInput) phraseInput.value = _phrase;

      if (!_enabled) _updateStatusBadge('off');
    },
  };

  global.VoiceSOS = VoiceSOS;

})(window);
