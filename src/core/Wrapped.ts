import busboy from "busboy";
import { IncomingMessage, OutgoingMessage, ServerResponse } from "http";
import { Http2ServerRequest, Http2ServerResponse } from "http2";
import { SessionUser } from "./SessionUser.js";
import { CookieSerializeOptions, parse, serialize } from "cookie";
import TempFolder from "./TempFolder.js";
import { LocalFile } from "./LocalFile.js";
import { Writable } from "stream";
import { ServiceProvider } from "@entity-access/entity-access/dist/di/di.js";
import CookieService from "../services/CookieService.js";
import { stat } from "fs/promises";
import TokenService from "../services/TokenService.js";
import { CacheProperty } from "./CacheProperty.js";
import Compression from "./Compression.js";


type UnwrappedRequest = IncomingMessage | Http2ServerRequest;

type UnwrappedResponse = ServerResponse | Http2ServerResponse;

export interface IFormData {
    fields: { [key: string]: string};
    files: LocalFile[];
}

const extendedSymbol = Symbol("extended");

export interface IWrappedRequest {

    headers?: any;

    disposables?: Disposable[];

    response?: WrappedResponse;

    get host(): string;

    get path(): string;

    get sessionUser(): SessionUser;

    get body(): any;

    get form(): IFormData;

    get params(): any;

    get query(): { [key: string]: string};

    get cookies(): { [key: string]: string};

    get URL(): URL;

    get remoteIPAddress(): string;

    accepts(): string[];
    accepts(... types: string[]): boolean;
}


export interface IWrappedResponse {

    request?: WrappedRequest;

    compress?: "gzip" | "deflate" | null;

    asyncEnd();

    asyncWrite(buffer: Buffer): Promise<void>;

    // setHeader(name: string, value: string);

    send(data: Buffer | string | Blob, status?: number): Promise<void>;

    sendRedirect(url: string, permanent?: boolean): void;

    cookie(name: string, value: string, options?: { secure?: boolean, httpOnly?: boolean, maxAge?: number });

    // https://github.com/phoenixinfotech1984/node-content-range
    sendFile(filePath: string, options?: {
        acceptRanges?: boolean,
        cacheControl?: boolean,
        maxAge?: number,
        etag?: boolean,
        immutable?: boolean,
        headers?: { [key: string]: string},
        lastModified?: boolean
    }): Promise<void>;

}

export type WrappedRequest = IWrappedRequest & UnwrappedRequest;

export type WrappedResponse = IWrappedResponse & UnwrappedResponse;

const extendRequest = (A: typeof IncomingMessage | typeof Http2ServerRequest) => {

    let c = A[extendedSymbol];
    if (!c) {
        c = class IntermediateRequest extends A implements IWrappedRequest{

            scope: ServiceProvider;
            disposables: Disposable[];

            get host(): string {
                const r = this as any as (Http2ServerRequest  | IncomingMessage);
                const host = (r as Http2ServerRequest).authority || r.headers[":authority"] || r.headers.host || null;
                return CacheProperty.value(this, "host", host);
            }
            get path(): string {
                return this.URL.pathname;
            }
            get cookies(): { [key: string]: string; } {
                const cookie = (this as any as UnwrappedRequest).headers.cookie;
                let cookies;
                if (cookie) {
                    try {
                        cookies = parse(cookie);
                    } catch {
                        // we will ignore this.. just in case...
                    }
                }
                return CacheProperty.value(this, "cookies", cookies ?? {});
            }
            get URL(): URL {
                const r = this as any as (Http2ServerRequest  | IncomingMessage);
                const url = new URL(r.url, `https:${this.host}`);
                return CacheProperty.value(this, "URL", url);
            }
            get remoteIPAddress(): string {
                const r = this as any as (Http2ServerRequest  | IncomingMessage);
                return CacheProperty.value(this, "remoteIPAddress", r.socket.remoteAddress);
            }

            accepts(... types: string[]): any {
                const h = this as any as IncomingMessage;
                const accepts = (h.headers.accept ?? "").split(";");
                const value = (...types: string[]) => {
                    if (types.length > 0) {
                        for (const type of types) {
                            for (const iterator of accepts) {
                                if (iterator.includes(type)) {
                                    return true;
                                }
                            }
                        }
                        return false;
                    }
                    return accepts;
                };

                Object.defineProperty(this, "accepts", {
                    value,
                    enumerable: true,
                    configurable: true
                });

                return value( ... types);
            }
        
            get query(): any {
                const value = {};
                for (const [key, v] of this.URL.searchParams.entries()) {
                    value[key] = v;
                }
                return CacheProperty.value(this, "query", value);
            }
        
            get body(): any {
                throw new Error("Please decorate `Ensure.parseBody` callee or call `await Ensure.parseBody(this)` before accessing this member");                
            }
        
            get form(): any {
                throw new Error("Please decorate `Ensure.parseForm` callee or call `await Ensure.parseForm(this)` before accessing this member");        
            }
        
            get params(): any {
                throw new Error("Please decorate `Ensure.parseAll` callee or call `await Ensure.parseAll(this)` before accessing this member");        
            }
        
            get sessionUser(): any {
                throw new Error("Please decorate `Ensure.authorize` callee or call `await Ensure.authorize(this)` before accessing this member");
            }
    
        }
        A[extendedSymbol] = c;
    }
    return c;
};

const extendResponse = (A: typeof ServerResponse | typeof Http2ServerResponse) => {
    let c = A[extendedSymbol];
    if (!c) {
        c = class WrappedResponse extends A implements IWrappedResponse {

            statusCode: number;

            compress?: "gzip" | "deflate" | null;

            asyncEnd(this: UnwrappedResponse) {
                return new Promise<void>((resolve) => this.end(resolve));
            }
        
            asyncWrite(this: UnwrappedResponse, buffer: Buffer, start?: number, length?: number) {
                return new Promise<void>((resolve, reject) => 
                    this.write(buffer, (error) => error ? reject(error) : resolve())
                );        
            }
        
            cookie(this: UnwrappedResponse, name: string, value: string, options: CookieSerializeOptions = {}) {
                const headers = this.getHeaders();
                const cv = headers["set-cookie"];
                const cookies = Array.isArray(cv)
                    ? cv
                    : (cv ? [cv] : []);
                const nk = cookies.filter((x) => !x.startsWith(name + "="));
                options.path ||= "/";
                nk.push(serialize(name, value, options));
                this.setHeader("set-cookie",nk);
            }

            // setHeader(this: UnwrappedResponse, name: string, value: string) {
            //     const headers = this.getHeaders();
            //     headers[name] = value;
            // }
        
            async send(this: UnwrappedResponse, data: Buffer | string, status: number = this.statusCode || 200) {
                try {
                    const wrapped = (this as any as WrappedResponse);
                    wrapped.statusCode = status;
                    const headers = this.getHeaders();
                    headers["content-type"] ??= "text/html";
                    if (typeof data === "string") {
                        data = Buffer.from(data, "utf-8");
                        let ct = headers["content-type"];
                        if (Array.isArray(ct)) {
                            ct = ct.join(";");
                        } else {
                            ct = ct.toString();
                        }
                        const index = ct.indexOf(";");
                        if (index !== -1) {
                            ct = ct.substring(0, index);
                        }
                        ct += "; charset=utf-8";
                    }
                    headers["content-length"] = data.length.toString();

                    // compress if required...
                    const { compress } = wrapped;
                    if (compress) {
                        let { accept } = headers;
                        if (typeof accept === "string") {
                            accept = accept.split(",");
                        } else {
                            accept = accept.flatMap((x) => x.split(","));
                        }
                        if (accept && accept.includes(compress)) {
                            switch(compress) {
                                case "deflate":
                                    data = Compression.deflate(data);
                                    headers["content-encoding"] = compress;
                                    break;
                                case "gzip":
                                    data = Compression.gzip(data);
                                    headers["content-encoding"] = compress;
                                    break;
                            }
                        }
                    }

                    this.writeHead(status, headers);

                    await new Promise<void>((resolve, reject) => {
                        this.write(data, (error) => error ? reject(error) : resolve());
                    });
                    return (this as any).asyncEnd();
                } catch (error) {
                    console.error(error);
                }
            }

            async sendRedirect(this: UnwrappedResponse, location: string, permanent = false) {
                this.statusCode = 301;
                this.writeHead(this.statusCode, {
                    location
                });
                return (this as any as IWrappedResponse).asyncEnd();
            }

            async sendFile(this: UnwrappedResponse, filePath: string, options?: {
                    acceptRanges?: boolean,
                    cacheControl?: boolean,
                    maxAge?: number,
                    etag?: boolean,
                    immutable?: boolean,
                    headers?: { [key: string]: string},
                    lastModified?: boolean
                }) {
                    /** Calculate Size of file */
                const { size } = await stat(filePath);
                const range = (this as any as IWrappedResponse).request.headers.range;
    
                const lf = new LocalFile(filePath);

                const headers = this.getHeaders();
                const oh = options?.headers;
                if (oh) {
                    for (const key in oh) {
                        if (Object.prototype.hasOwnProperty.call(oh, key)) {
                            const element = oh[key];
                            headers[key] = element;
                        }
                    }
                }

                /** Check for Range header */
                if (!range) {
                    headers["content-length"] = size;
                    this.writeHead(200, headers);
    
                    await lf.writeTo(this);
    
                    return (this as any).asyncEnd();
                }
    
                /** Extracting Start and End value from Range Header */
                let [start, end] = range.replace(/bytes=/, "").split("-") as any[];
                start = parseInt(start, 10);
                end = end ? parseInt(end, 10) : size - 1;
    
                if (!isNaN(start) && isNaN(end)) {
                    start = start;
                    end = size - 1;
                }
                if (isNaN(start) && !isNaN(end)) {
                    start = size - end;
                    end = size - 1;
                }
    
                // Handle unavailable range request
                if (start >= size || end >= size) {
                    // Return the 416 Range Not Satisfiable.
                    headers["content-range"] = `bytes */${size}`;
                    this.writeHead(416, headers);
                    return (this as any).asyncEnd();
                }
    
                /** Sending Partial Content With HTTP Code 206 */
                headers["accept-ranges"] = "bytes";
                headers["content-range"] = `bytes ${start}-${end}/${size}`;
                headers["content-length"] = end - start + 1;
                this.writeHead(206, headers);
                await lf.writeTo(this, start, end);
    
            }
        }
    }
    return c;
}


export const Wrapped = {
    request: (req: UnwrappedRequest) => {
        const { constructor } = Object.getPrototypeOf(req);
        const { prototype } = extendRequest(constructor);
        Object.setPrototypeOf(req, prototype);
        const wr = req as WrappedRequest;
        wr.disposables = [];
        return req;
    },

    response: (req: WrappedRequest, res: UnwrappedResponse) => {
        const { constructor } = Object.getPrototypeOf(res);
        const { prototype } = extendResponse(constructor);
        Object.setPrototypeOf(res, prototype);
        const wr = res as WrappedResponse;
        wr.request = req;
        req.response = wr;
        return res;
    }
}