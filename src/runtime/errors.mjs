export class GatewayError extends Error {
  /** @param {string} code */
  constructor(code) { super(code); this.name = 'GatewayError'; this.code = code; }
}
