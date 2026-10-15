import net from 'node:net';

// A tiny SMTP server the test controls (#2944).
//
// WHY. The mail queue's whole job is what happens when a relay says something
// other than 250 — a `450 4.7.1` throttle, a `452` about one mailbox, a `550`,
// or nothing at all. No real relay can be told to do that on cue, and CI must
// never reach one. This speaks just enough SMTP (greeting, EHLO/HELO, MAIL,
// RCPT, DATA, RSET, NOOP, QUIT — no TLS, no AUTH, so nodemailer skips both) to
// be the server nodemailer talks to, and answers each step the way the test
// says.
//
// It never relays anything: an accepted message is kept in `messages` and
// nowhere else.

export type SmtpStage = 'GREETING' | 'MAIL' | 'RCPT' | 'DATA';

export type FakeSmtpMode =
  | { kind: 'accept' }
  /** Answer `reply` (e.g. '450 4.7.1 Error: too much mail') at `stage`. */
  | { kind: 'refuse'; stage: SmtpStage; reply: string }
  /** Accept the TCP connection and never say a word: a wedged relay. */
  | { kind: 'hang' };

export interface ReceivedMessage {
  from: string;
  to: string[];
  data: string;
}

export interface FakeSmtp {
  port: number;
  mode: FakeSmtpMode;
  /** Every accepted message, in order. */
  messages: ReceivedMessage[];
  /** TCP connections opened so far (a breaker test asserts none). */
  connections: number;
  /** Messages whose DATA or envelope named this address. */
  to(address: string): ReceivedMessage[];
  close(): Promise<void>;
}

const ADDRESS = /<([^>]*)>/;

export async function startFakeSmtp(mode: FakeSmtpMode = { kind: 'accept' }): Promise<FakeSmtp> {
  const sockets = new Set<net.Socket>();
  const state: FakeSmtp = {
    port: 0,
    mode,
    messages: [],
    connections: 0,
    to(address: string) {
      const a = address.toLowerCase();
      return this.messages.filter((m) => m.to.some((t) => t.toLowerCase() === a));
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };

  const refuseAt = (stage: SmtpStage): string | null =>
    state.mode.kind === 'refuse' && state.mode.stage === stage ? state.mode.reply : null;

  const server = net.createServer((socket) => {
    state.connections++;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    if (state.mode.kind === 'hang') return;

    const say = (line: string) => socket.write(`${line}\r\n`);
    const greet = refuseAt('GREETING');
    if (greet) {
      say(greet);
      socket.end();
      return;
    }
    say('220 fake-smtp.test ESMTP ready');

    let buffer = '';
    let inData = false;
    let data = '';
    let from = '';
    let rcpts: string[] = [];

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end === -1) return;
          data += buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          inData = false;
          state.messages.push({ from, to: rcpts, data: data.replace(/\r\n\.\./g, '\r\n.') });
          say('250 2.0.0 Ok: queued');
          from = '';
          rcpts = [];
          data = '';
          continue;
        }
        const nl = buffer.indexOf('\r\n');
        if (nl === -1) return;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 2);
        const verb = line.split(/[\s:]/)[0].toUpperCase();
        switch (verb) {
          case 'EHLO':
            say('250-fake-smtp.test');
            say('250-SIZE 10485760');
            say('250 8BITMIME');
            break;
          case 'HELO':
            say('250 fake-smtp.test');
            break;
          case 'MAIL': {
            const r = refuseAt('MAIL');
            if (r) {
              say(r);
              break;
            }
            from = line.match(ADDRESS)?.[1] ?? '';
            say('250 2.1.0 Ok');
            break;
          }
          case 'RCPT': {
            const r = refuseAt('RCPT');
            if (r) {
              say(r);
              break;
            }
            rcpts.push(line.match(ADDRESS)?.[1] ?? '');
            say('250 2.1.5 Ok');
            break;
          }
          case 'DATA': {
            const r = refuseAt('DATA');
            if (r) {
              say(r);
              break;
            }
            inData = true;
            say('354 End data with <CR><LF>.<CR><LF>');
            break;
          }
          case 'RSET':
            from = '';
            rcpts = [];
            say('250 2.0.0 Ok');
            break;
          case 'NOOP':
            say('250 2.0.0 Ok');
            break;
          case 'QUIT':
            say('221 2.0.0 Bye');
            socket.end();
            return;
          default:
            say('502 5.5.2 Error: command not recognized');
        }
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  state.port = (server.address() as net.AddressInfo).port;
  return state;
}
