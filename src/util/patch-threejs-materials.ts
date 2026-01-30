// Global patch for Three.js materials to fix USD loader compatibility issues
// This must run BEFORE any Three.js code loads

// Wait for window to be available
if (typeof window !== "undefined") {
    // Store original Object.defineProperty
    const originalDefineProperty = Object.defineProperty;

    // Intercept all Object.defineProperty calls to catch Three.js material definitions
    (Object as any).defineProperty = function (
        this: any,
        obj: any,
        prop: string | symbol,
        descriptor: PropertyDescriptor
    ) {
        // Check if this is trying to define onBeforeRender on a Material prototype
        if (
            prop === "onBeforeRender" &&
            obj &&
            obj.constructor &&
            obj.constructor.name &&
            (obj.constructor.name.includes("Material") ||
                obj.constructor.name === "Material")
        ) {
            // Return a dummy descriptor that does nothing
            return originalDefineProperty.call(Object, obj, prop, {
                get: () => undefined,
                set: () => {}, // Silently ignore
                configurable: false,
                enumerable: false,
            });
        }
        // Otherwise, call the original
        return originalDefineProperty.call(Object, obj, prop, descriptor);
    };
}

export {};
