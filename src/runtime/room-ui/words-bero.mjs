// Words for Bero (part D): say codes, card codes, choice codes and the avatar / card chrome.
// Keys are namespaced (`bero.say.*`, `bero.card.*`, `bero.choice.*`, `bero.ui.*`) so the dictionaries of other parts never collide.
// A hands DONE is always a claim: no line here says it was checked or verified.
export const sayKey = (code) => `bero.say.${code}`;
export const cardKey = (code) => `bero.card.${code}`;
export const choiceKey = (code) => `bero.choice.${code}`;

const en = {
  'bero.ui.name': 'Bero',
  'bero.ui.for': '{cam} · for you to decide',
  'bero.ui.claim_note': 'This is what the AI says about itself. Nobody has checked it yet.',
  'bero.ui.ba_note': 'Before / after frames of this camera',
  'bero.ui.chosen': 'Sent',

  'bero.say.patrol': 'Looking around the cameras.',
  'bero.say.stalled': '{cam} has not moved for {seconds} s. Something may be in the way. Shall I have it closed?',
  'bero.say.claimed_done': '{cam} says it is done: "{claim}". That is its own claim. Check again?',
  'bero.say.claimed_failed': '{cam} says it could not finish: "{claim}". Have a look?',
  'bero.say.limit_reached': '{cam} hit its limit after {steps} steps (${usd}). It stopped there.',
  'bero.say.error': '{cam} stopped with an error. Shall I have it look again?',
  'bero.say.progress': '{cam} is moving along: {steps} steps since I last looked. Here is the flow.',
  'bero.say.summary': 'In the last few minutes you decided {count} things. Here is who did what.',
  'bero.say.ask': 'One thing for you to decide.',
  'bero.say.doing_it': 'Got it. Passing that to the hands on {cam}.',
  'bero.say.thanks': 'Noted. I will keep watching {cam}.',

  'bero.card.stalled': '{cam} has not moved for {seconds} s. Have it close what is in the way?',
  'bero.card.claimed_done': '{cam} says it is done. Check the screen again, or take its word?',
  'bero.card.claimed_failed': '{cam} says it could not finish. Have it look again?',
  'bero.card.limit_reached': '{cam} stopped at its limit ({steps} steps, ${usd}). Check what it got done?',
  'bero.card.error': '{cam} stopped with an error. Have it look at the screen again?',

  'bero.choice.close_it': 'Close it',
  'bero.choice.stop_it': 'Stop',
  'bero.choice.later': 'Later',
  'bero.choice.check_again': 'Check again',
  'bero.choice.mark_done': 'Mark done',
  'bero.choice.noted': 'OK, leave it',
};

const ja = {
  'bero.ui.name': 'ベロ',
  'bero.ui.for': '{cam} · あなたが決めること',
  'bero.ui.claim_note': 'AI 自身の申告です。まだ誰も確かめていません。',
  'bero.ui.ba_note': 'このカメラの前と後',
  'bero.ui.chosen': '伝えました',

  'bero.say.patrol': 'カメラを見回っています。',
  'bero.say.stalled': '{cam} が {seconds} 秒止まっています。何かが邪魔しているみたい。閉じさせますか?',
  'bero.say.claimed_done': '{cam} が「{claim}」と言っています。本人の申告です。もう一度確かめますか?',
  'bero.say.claimed_failed': '{cam} が「{claim}」と言って止まりました。見てみますか?',
  'bero.say.limit_reached': '{cam} が上限に届きました ({steps} 手 · ${usd})。そこで止まっています。',
  'bero.say.error': '{cam} がエラーで止まりました。もう一度画面を見させますか?',
  'bero.say.progress': '{cam} は進んでいます。前に見てから {steps} 手。流れを図にします。',
  'bero.say.summary': 'さっきの数分で、あなたが決めたのは {count} つでした。誰が何をしたか並べます。',
  'bero.say.ask': 'ひとつ決めてほしいことがあります。',
  'bero.say.doing_it': '了解。{cam} の手に渡しました。',
  'bero.say.thanks': 'わかりました。{cam} はこのまま見ておきます。',

  'bero.card.stalled': '{cam} が {seconds} 秒止まっています。邪魔なものを閉じさせますか?',
  'bero.card.claimed_done': '{cam} が終わったと言っています。画面をもう一度確かめますか?',
  'bero.card.claimed_failed': '{cam} ができなかったと言っています。もう一度見させますか?',
  'bero.card.limit_reached': '{cam} が上限で止まりました ({steps} 手 · ${usd})。どこまでできたか確かめますか?',
  'bero.card.error': '{cam} がエラーで止まりました。画面をもう一度見させますか?',

  'bero.choice.close_it': '閉じさせて',
  'bero.choice.stop_it': '止める',
  'bero.choice.later': '後で',
  'bero.choice.check_again': 'もう一度確かめて',
  'bero.choice.mark_done': '終わりにする',
  'bero.choice.noted': 'このままでいい',
};

/** The dictionary for makeWords(...dicts) (room-ui/i18n.mjs): { en, ja }. */
export const WORDS_BERO = Object.freeze({ en: Object.freeze(en), ja: Object.freeze(ja) });
export default WORDS_BERO;
