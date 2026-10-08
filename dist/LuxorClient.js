"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.LuxorClient = exports.LuxorError = void 0;
exports.statusText = statusText;
exports.errorMessage = errorMessage;
exports.sleep = sleep;
const node_http_1 = __importDefault(require("node:http"));
// Luxor controllers run a tiny embedded web server that falls over easily.  Everything in here
// exists to be gentle with it:
//  - one request at a time, with a short gap between requests
//  - a fresh TCP connection per request ("Connection: close").  Node 19+ turned HTTP keep-alive
//    on by default, and reusing a socket the controller has already dropped produces the
//    ECONNRESET / "Error communicating with controller" failures.
//  - a hard per-attempt timeout and a couple of quick retries for transport failures
const MIN_GAP_MS = 100;
const RETRY_DELAYS_MS = [250, 750, 1500];
class LuxorError extends Error {
    status;
    // `status` is set when the controller answered with a non-zero Status code.  Those are
    // deterministic (bad group number, etc.) so they are never retried.
    constructor(message, status) {
        super(message);
        this.status = status;
        this.name = 'LuxorError';
    }
}
exports.LuxorError = LuxorError;
class LuxorClient {
    opts;
    chain = Promise.resolve();
    lastRequestAt = 0;
    constructor(opts) {
        this.opts = opts;
    }
    // Queue a call to http://<ip>/<method>.json.  Calls run strictly in order.
    request(method, body) {
        const run = () => this.withRetries(method, body);
        const result = this.chain.then(run, run);
        this.chain = result.catch(() => undefined);
        return result;
    }
    async withRetries(method, body) {
        let lastErr;
        for (let attempt = 0; attempt <= this.opts.retries; attempt++) {
            if (attempt > 0) {
                await sleep(RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)]);
            }
            try {
                return await this.send(method, body);
            }
            catch (err) {
                if (err instanceof LuxorError && err.status !== undefined)
                    throw err;
                lastErr = err;
                this.opts.log.debug(`${method} attempt ${attempt + 1}/${this.opts.retries + 1} failed: ${errorMessage(err)}`);
            }
        }
        throw lastErr;
    }
    async send(method, body) {
        const wait = MIN_GAP_MS - (Date.now() - this.lastRequestAt);
        if (wait > 0)
            await sleep(wait);
        try {
            return await post(this.opts.ip, method, body, this.opts.timeout);
        }
        finally {
            this.lastRequestAt = Date.now();
        }
    }
}
exports.LuxorClient = LuxorClient;
function post(ip, method, body, timeout) {
    return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : '';
        const [host, port] = ip.split(':');
        const req = node_http_1.default.request({
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
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('error', fail);
            res.on('end', () => {
                clearTimeout(timer);
                if (res.statusCode !== 200)
                    return reject(new LuxorError(`HTTP ${res.statusCode} from ${method}.json`));
                let json;
                try {
                    json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                }
                catch {
                    return reject(new LuxorError(`Unparseable response from ${method}.json`));
                }
                if (typeof json.Status === 'number' && json.Status !== 0) {
                    return reject(new LuxorError(`Controller answered ${method}.json with '${statusText(json.Status)}'`, json.Status));
                }
                resolve(json);
            });
        });
        const timer = setTimeout(() => req.destroy(new LuxorError(`${method}.json timed out after ${timeout}ms`)), timeout);
        function fail(err) {
            clearTimeout(timer);
            reject(err);
        }
        req.on('error', fail);
        req.end(payload);
    });
}
function statusText(status) {
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
function errorMessage(err) {
    return err instanceof Error ? err.message : String(err);
}
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
//# sourceMappingURL=LuxorClient.js.map