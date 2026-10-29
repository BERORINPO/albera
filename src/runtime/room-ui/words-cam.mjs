// Words for the cameras (part B). Codes are used by cam.mjs only. A finished run is always shown as a claim.
const en = {
  'cam.title': 'CAM {n} · {label}',
  'cam.rec': 'REC {time}',
  'cam.rec_off': 'not live',
  'cam.screen_alt': 'Screen of {label}',
  'cam.idle': 'no AI on this VM',
  'cam.band': 'step {step} · {action} · ${usd}',
  'cam.claim': 'AI claims: {claim} (self-reported, check the VM)',
  'cam.no_message': '(no message)',
  'cam.ended': 'AI run ended: {outcome} (not verified)',
  'cam.outcome.limit_reached': 'limit reached',
  'cam.outcome.stopped': 'stopped',
  'cam.outcome.refused': 'refused',
  'cam.outcome.error': 'error',
  'cam.tone.work': 'working',
  'cam.tone.wait': 'your turn',
  'cam.tone.stuck': 'look here',
  'cam.tone.off': 'idle',
  'cam.note.pending': 'waiting for the first frame',
  'cam.note.stale': 'old frame: the picture is not fresh',
  'cam.note.error': 'capture failed: {code}',
};

const ja = {
  'cam.title': 'CAM {n} · {label}',
  'cam.rec': 'REC {time}',
  'cam.rec_off': '停止',
  'cam.screen_alt': '{label} の画面',
  'cam.idle': 'この VM に AI はいません',
  'cam.band': 'step {step} · {action} · ${usd}',
  'cam.claim': 'AI の申告: {claim}（自己申告です。VM を確かめてください）',
  'cam.no_message': '（メッセージなし）',
  'cam.ended': 'AI の作業が終わりました: {outcome}（確認されていません）',
  'cam.outcome.limit_reached': '上限に到達',
  'cam.outcome.stopped': '停止',
  'cam.outcome.refused': '拒否',
  'cam.outcome.error': 'エラー',
  'cam.tone.work': '作業中',
  'cam.tone.wait': 'あなた待ち',
  'cam.tone.stuck': '要確認',
  'cam.tone.off': '待機',
  'cam.note.pending': '最初の画面を待っています',
  'cam.note.stale': '古い画面です（更新が止まっています）',
  'cam.note.error': '画面を取れませんでした: {code}',
};

export const WORDS_CAM = Object.freeze({ en: Object.freeze(en), ja: Object.freeze(ja) });
export default WORDS_CAM;
