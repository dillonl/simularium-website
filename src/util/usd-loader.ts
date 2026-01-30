import { USDZLoader } from "three-usdz-loader";
import { Group, MeshPhysicalMaterial, MeshStandardMaterial } from "three";

export interface USDLoadResult {
    group: Group;
    instance: any; // USDZInstance
}

// Global flag to track if we've already patched materials
let materialsPatchedGlobally = false;

export const loadUsdFile = async (file: File): Promise<USDLoadResult> => {
    // The WASM files are copied to /wasm by Webpack
    // Doc says "without the end slash"
    const wasmUrl = window.location.origin + "/wasm";
    const loader = new USDZLoader(wasmUrl);

    // Monkey-patch MeshPhysicalMaterial ONCE globally to prevent undefined envMap errors
    // and to remove onBeforeRender callbacks that cause issues
    // This needs to be permanent because USD creates materials during rendering
    if (!materialsPatchedGlobally) {
        const originalSetValues = (MeshPhysicalMaterial.prototype as any)
            .setValues;
        (MeshPhysicalMaterial.prototype as any).setValues = function (
            values: any
        ) {
            if (values && values.envMap === undefined) {
                values.envMap = null;
            }
            if (values && values.map === undefined) {
                values.map = null;
            }
            // Remove onBeforeRender if present - USD loader adds these but they're incompatible
            if (values && values.onBeforeRender) {
                delete values.onBeforeRender;
            }
            return originalSetValues.call(this, values);
        };

        // Also patch the onBeforeRender property to prevent it from being set
        const descriptor = Object.getOwnPropertyDescriptor(
            MeshPhysicalMaterial.prototype,
            "onBeforeRender"
        );
        if (!descriptor || descriptor.configurable) {
            Object.defineProperty(
                MeshPhysicalMaterial.prototype,
                "onBeforeRender",
                {
                    set: function (value: any) {
                        // Silently ignore attempts to set onBeforeRender
                    },
                    get: function () {
                        return undefined;
                    },
                    configurable: false, // Make it non-configurable so it can't be changed
                }
            );
        }

        materialsPatchedGlobally = true;
    }

    try {
        console.log(
            "Loading USD file:",
            file.name,
            "size:",
            file.size,
            "bytes"
        );
        const group = new Group();
        const usdInstance = await loader.loadFile(file, group);
        console.log("USD file loaded successfully");

        // Log animation metadata if available
        if (usdInstance) {
            const instance = usdInstance as any;
            console.log("USD Instance metadata:", {
                endTimecode: instance.endTimecode,
                timeout: instance.timeout,
                hasUpdate: typeof instance.update === "function",
            });
            if (instance.endTimecode && instance.timeout) {
                const fps = 1000 / instance.timeout;
                const duration = instance.endTimecode / fps;
                console.log(
                    `USD Animation: ${
                        instance.endTimecode
                    } frames at ${fps.toFixed(1)} FPS (${duration.toFixed(1)}s)`
                );
            } else {
                console.log("USD file has no animation data (static scene)");
            }
        }

        console.log("USD loaded with", group.children.length, "root objects");
        group.traverse((obj: any) => {
            if (obj.isMesh) {
                console.log("Found mesh:", obj.name || "unnamed", {
                    materialType: obj.material?.type,
                    color: obj.material?.color,
                    hasOnBeforeRender: !!obj.material?.onBeforeRender,
                });
            }
        });

        // Replace USD materials with simple MeshStandardMaterial
        // USD materials have custom shaders that conflict with SimulariumRenderer
        const replaceMaterials = (obj: any) => {
            obj.traverse((object: any) => {
                if (object.isMesh && object.material) {
                    // Always replace ALL USD materials to avoid onBeforeRender issues
                    const mat = object.material;

                    // Extract color from the original material
                    const originalColor = mat.color?.clone() || {
                        r: 0.8,
                        g: 0.8,
                        b: 0.8,
                    };
                    const originalOpacity =
                        mat.opacity !== undefined ? mat.opacity : 1;
                    const originalTransparent = mat.transparent || false;

                    // Replace with a simple MeshStandardMaterial that works with the renderer
                    const newMaterial = new MeshStandardMaterial({
                        color: originalColor,
                        opacity: originalOpacity,
                        transparent: originalTransparent,
                        metalness: 0.1,
                        roughness: 0.8,
                    });

                    // Set onBeforeRender to an empty function to avoid errors
                    newMaterial.onBeforeRender = () => {};

                    object.material = newMaterial;
                }
            });
        };

        // Initial material replacement
        replaceMaterials(group);

        // Store the replacement function on the instance so it can be called during animation
        (usdInstance as any).replaceMaterials = () => replaceMaterials(group);

        return { group, instance: usdInstance };
    } catch (error) {
        console.error("Error loading USD file:", error);
        if (error instanceof Error) {
            console.error("Error message:", error.message);
            console.error("Error stack:", error.stack);
        }
        throw new Error(
            `Failed to load USD file: ${
                error instanceof Error ? error.message : String(error)
            }`
        );
    }
};
