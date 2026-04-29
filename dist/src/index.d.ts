import { EmitContext } from "@typespec/compiler";
export type EmitterOptions = {
    "emitter-output-dir": string;
};
export declare function $onEmit(context: EmitContext<EmitterOptions>): Promise<void>;
