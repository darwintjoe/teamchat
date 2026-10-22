// TEMPORARY auth-probe HTTP routes. Not product auth.
import { httpRouter } from "convex/server";
import { auth } from "./auth";

const http = httpRouter();
auth.addHttpRoutes(http);

export default http;
