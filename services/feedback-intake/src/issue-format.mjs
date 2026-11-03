// The issue the intake files in the private intake repository. The title is fixed (the receipt only), so no sender text reaches a title, a notification
// subject or a search result header. The sender's text goes inside a fenced code block whose fence is longer than any backtick run in it, so an @mention, a link
// or an image (a tracking pixel) in the text does nothing. The version is printable ASCII (checked by the contract) and goes in an inline code span of its own.

const fenceFor = (text) => '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((run) => run[0].length + 1)));

/**
 * @param {{ text: string, version: string }} value  a checked request
 * @param {string} receipt  e.g. FB-7K3Q-2M
 * @param {string} receivedAt  ISO time
 * @returns {{ title: string, body: string }}
 */
export function issueOf(value, receipt, receivedAt) {
  const textFence = fenceFor(value.text);
  const versionFence = '`'.repeat(Math.max(1, ...[...value.version.matchAll(/`+/g)].map((run) => run[0].length + 1)));
  const body = [
    `Receipt: ${receipt}`,
    `Received: ${receivedAt}`,
    `ALBERA version: ${versionFence} ${value.version} ${versionFence}`,
    '',
    'Text as sent (inside a code block: mentions, links and images in it do nothing):',
    '',
    `${textFence}text`,
    value.text,
    textFence,
    '',
    'Not kept here: the IP address, the install id and any user name. Do not copy this issue to a public repository; write a new one without personal details.',
  ].join('\n');
  return { title: `[feedback] ${receipt}`, body };
}
