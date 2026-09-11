import { getPreference, setPreference } from '../db/indexedDB';

export function voiceSupported() {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
}

export async function isVoiceGuidanceEnabled() {
  return (await getPreference('voiceGuidance')) === true;
}

export function speak(text, language = 'en') {
  if (!voiceSupported() || !text) return false;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = { hi: 'hi-IN', pa: 'pa-IN', bn: 'bn-IN', ta: 'ta-IN' }[language] || 'en-IN';
  utterance.rate = 0.9;
  window.speechSynthesis.speak(utterance);
  return true;
}

export async function setVoiceGuidanceEnabled(enabled) {
  await setPreference('voiceGuidance', enabled);
  if (!enabled && voiceSupported()) window.speechSynthesis.cancel();
}
