import type { NextFunction, Request, Response } from "express";
import { trackProxyCall } from "../lib/lifecycle.js";

// Marks a paid proxy call as in flight until its response is finished or the
// client goes away, so graceful shutdown waits for it before closing the DB
// pool (issue #216).
export function proxyTrackingMiddleware(_req: Request, res: Response, next: NextFunction): void {
  const release = trackProxyCall();
  res.on("finish", release);
  res.on("close", release);
  next();
}
