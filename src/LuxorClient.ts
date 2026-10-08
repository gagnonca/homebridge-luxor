import http from 'node:http';
import { Logger } from 'homebridge';

// Luxor controllers run a tiny embedded web server that falls over easily.  Everything in here
// exists to be gentle with it:
//  - one request at a time, with a short gap between requests
//  - a fresh TCP connection per request ("Connection: close").  Node 19+ turned HTTP keep-alive
//    on by default, and reusing a socket the controller has already dropped produces the
//    ECONNRESET / "Error communicating with controller" failures.
//  - a hard per-attempt timeout and a couple of quick retries for transport failures

const MIN_GAP_MS = 100;
const RETRY_DELAYS_MS = [250, 750, 1500];

export class LuxorError extends Error {
  // `status` is set when the controller answered with a non-zero Status code.  Those are
  // deterministic (bad group number, etc.) so they are never retried.
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = 'LuxorError';
  }
}

export interface LuxorClientOptions {
  ip: string;
  timeout: number;
  retries: number;
  log: Logger;
}

export class LuxorClient {
  private chain: Promise<unknown> = Promise.resolve();
  private lastRequestAt = 0;

  constructor(private readonly opts: LuxorClientOptions) { }

  // Queue a call to http://<ip>/<method>.json.  Calls run strictly in order.
  request<T = any>(method: string, body?: object): Promise<T> {
    const run = () => this.withRetries<T>(method, body);
    const result = this.chain.then(run, run);
    this.chain = result.catch(() => undefined);
    return result;
  }

  private async withRetries<T>(method: string, body?: object): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.opts.retries; attempt++) {
      if (attempt > 0) {
        await sleep(RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)]);
      }
      try {
        return await this.send<T>(method, body);
      }
      catch (err) {
        if (err instanceof LuxorError && err.status !== undefined) throw err;
        lastErr = err;
        this.opts.log.debug(`${method} attempt ${attempt + 1}/${this.opts.retries + 1} failed: ${errorMessage(err)}`);
      }
    }
    throw lastErr;
  }

  private async send<T>(method: string, body?: object): Promise<T> {
    const wait = MIN_GAP_MS - (Date.now() - this.lastRequestAt);
    if (wait > 0) await sleep(wait);
    try {
      return await post<T>(this.opts.ip, method, body, this.opts.timeout);
    }
    finally {
      this.lastRequestAt = Date.now();
    }
  }
}

function post<T>(ip: string, method: string, body: object | undefined, timeout: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const [host, port] = ip.split(':');
    const req = http.request({
      host,
      port: port ? Number(port) : 80,
      path: `/${method}.json`,
      method: 'POST',
      agent: false,
      headers: {
        'Connection': 'close',
        'Cache-Control': 'no-cache',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('error', fail);
      res.on('end', () => {
        clearTimeout(timer);
        if (res.statusCode !== 200) return reject(new LuxorError(`HTTP ${res.statusCode} from ${method}.json`));
        let json: any;
        try {
          json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        }
        catch {
          return reject(new LuxorError(`Unparseable response from ${method}.json`));
        }
        if (typeof json.Status === 'number' && json.Status !== 0) {
          return reject(new LuxorError(`Controller answered ${method}.json with '${statusText(json.Status)}'`, json.Status));
        }
        resolve(json as T);
      });
    });
    const timer = setTimeout(() => req.destroy(new LuxorError(`${method}.json timed out after ${timeout}ms`)), timeout);
    function fail(err: Error) {
      clearTimeout(timer);
      reject(err);
    }
    req.on('error', fail);
    req.end(payload);
  });
}

export function statusText(status: number): string {
  switch (status) {
    case 0: return 'Ok';
    case 1: return 'Unknown Method';
    case 101: return 'Unparseable Request';
    case 102: return 'Invalid Request';
    case 151: return 'Color Value Out of Range';
    case 201: return 'Precondition Failed';
    case 202: return 'Group Name In Use';
    case 205: return 'Group Number In Use';
    case 241: return 'Item Does Not Exist';
    case 242: return 'Bad Group Number';
    case 243: return 'Theme Index Out Of Range';
    case 251: return 'Bad Theme Index';
    case 252: return 'Theme Changes Restricted';
    default: return `Unknown status ${status}`;
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
