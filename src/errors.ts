export interface TonApiErrorDetails {
  method: string;
  url: string;
  status: number;
  statusText: string;
  responseBody?: unknown;
}

export class TonApiError extends Error {
  public readonly method: string;
  public readonly url: string;
  public readonly status: number;
  public readonly statusText: string;
  public readonly responseBody?: unknown;

  public constructor(message: string, details: TonApiErrorDetails) {
    super(message);
    this.name = "TonApiError";
    this.method = details.method;
    this.url = details.url;
    this.status = details.status;
    this.statusText = details.statusText;
    this.responseBody = details.responseBody;
  }
}

