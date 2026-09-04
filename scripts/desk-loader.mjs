import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("./desk-hooks.mjs", import.meta.url);
void pathToFileURL;
