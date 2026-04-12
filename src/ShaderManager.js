const twgl = require('twgl.js');


const DEFAULT_EFFECT_INFO = {
    /** Color effect */
    color: {
        uniformName: 'u_color',
        mask: 1 << 0,
        converter: x => (x / 200) % 1,
        shapeChanges: false
    },
    /** Fisheye effect */
    fisheye: {
        uniformName: 'u_fisheye',
        mask: 1 << 1,
        converter: x => Math.max(0, (x + 100) / 100),
        shapeChanges: true
    },
    /** Whirl effect */
    whirl: {
        uniformName: 'u_whirl',
        mask: 1 << 2,
        converter: x => -x * Math.PI / 180,
        shapeChanges: true
    },
    /** Pixelate effect */
    pixelate: {
        uniformName: 'u_pixelate',
        mask: 1 << 3,
        converter: x => Math.abs(x) / 10,
        shapeChanges: true
    },
    /** Mosaic effect */
    mosaic: {
        uniformName: 'u_mosaic',
        mask: 1 << 4,
        converter: x => {
            x = Math.round((Math.abs(x) + 10) / 10);
            /** @todo cap by Math.min(srcWidth, srcHeight) */
            return Math.max(1, Math.min(x, 512));
        },
        shapeChanges: true
    },
    /** Brightness effect */
    brightness: {
        uniformName: 'u_brightness',
        mask: 1 << 5,
        converter: x => Math.max(-100, Math.min(x, 100)) / 100,
        shapeChanges: false
    },
    /** Ghost effect */
    ghost: {
        uniformName: 'u_ghost',
        mask: 1 << 6,
        converter: x => 1 - (Math.max(0, Math.min(x, 100)) / 100),
        shapeChanges: false
    }
};


class ShaderManager {
    /**
     * @param {WebGLRenderingContext} gl WebGL rendering context to create shaders for
     * @constructor
     */
    constructor (gl) {
        this._gl = gl;

        /**
         * The cache of all shaders compiled so far, filled on demand.
         * @type {Object<ShaderManager.DRAW_MODE, Array<ProgramInfo>>}
         * @private
         */
        this._shaderCache = {};
        for (const modeName in ShaderManager.DRAW_MODE) {
            if (Object.prototype.hasOwnProperty.call(ShaderManager.DRAW_MODE, modeName)) {
                this._shaderCache[modeName] = [];
            }
        }

        /* eslint-disable global-require */
        this.exports = {
            /**
             * Sprite shader exports
             */
            sprite: {
                vert: require('raw-loader!./shaders/sprite.vert'),
                frag: require('raw-loader!./shaders/sprite.frag')
            },
        };
        /* eslint-enable global-require */
    }

    /**
     * Register a custom sprite effect.
     * @param {string} effectName The effect's unique name.
     * @param {object} [effectInfo] Effect metadata and shader hook snippets.
     * @param {string} [effectInfo.uniformName] Name of the GLSL uniform.
     * @param {number} [effectInfo.mask] Explicit bitmask. If omitted, first free mask is used.
     * @param {function} [effectInfo.converter] Conversion from Scratch value to shader uniform value.
     * @param {boolean} [effectInfo.shapeChanges] Whether this effect can change rendered shape.
     * @param {string} [effectInfo.fragmentUniforms] GLSL uniform declarations for the fragment shader.
     * @param {string} [effectInfo.fragmentTexcoord] GLSL code that mutates texcoord0 before sampling u_skin.
     * @param {string} [effectInfo.fragmentColor] GLSL code that mutates gl_FragColor after color/brightness.
     * @returns {string} The normalized effect name.
     */
    registerEffect (effectName, effectInfo = {}) {
        effectInfo = effectInfo || {};
        const normalizedEffectName = ShaderManager.registerEffect(effectName, effectInfo);
        this._clearShaderCache();
        return normalizedEffectName;
    }

    /**
     * Reset cached shader programs after effect registry changes.
     * @private
     */
    _clearShaderCache () {
        for (const modeName in this._shaderCache) {
            if (Object.prototype.hasOwnProperty.call(this._shaderCache, modeName)) {
                this._shaderCache[modeName] = [];
            }
        }
    }

    /**
     * Fetch the shader for a particular set of active effects.
     * Build the shader if necessary.
     * @param {ShaderManager.DRAW_MODE} drawMode Draw normally, silhouette, etc.
     * @param {int} effectBits Bitmask representing the enabled effects.
     * @returns {ProgramInfo} The shader's program info.
     */
    getShader (drawMode, effectBits) {
        const cache = this._shaderCache[drawMode];
        if (drawMode === ShaderManager.DRAW_MODE.silhouette) {
            // Silhouette mode isn't affected by these effects.
            effectBits &= ~(ShaderManager.EFFECT_INFO.color.mask | ShaderManager.EFFECT_INFO.brightness.mask);
        }
        let shader = cache[effectBits];
        if (!shader) {
            shader = cache[effectBits] = this._buildShader(drawMode, effectBits);
        }
        return shader;
    }

    /**
     * Build the shader for a particular set of active effects.
     * @param {ShaderManager.DRAW_MODE} drawMode Draw normally, silhouette, etc.
     * @param {int} effectBits Bitmask representing the enabled effects.
     * @returns {ProgramInfo} The new shader's program info.
     * @private
     */
    _buildShader (drawMode, effectBits) {
        const numEffects = ShaderManager.EFFECTS.length;

        const defines = [
            `#define DRAW_MODE_${drawMode}`
        ];
        for (let index = 0; index < numEffects; ++index) {
            const effectName = ShaderManager.EFFECTS[index];
            const effectInfo = ShaderManager.EFFECT_INFO[effectName];
            if ((effectBits & effectInfo.mask) !== 0) {
                defines.push(`#define ENABLE_${effectName}`);
            }
        }

        const definesText = `${defines.join('\n')}\n`;

        const vsFullText = definesText + this.exports.sprite.vert;
        const fsFullText = definesText + this._injectEffectShaderSections(this.exports.sprite.frag, effectBits);

        let errorMessage = null;
        const onError = newError => {
            // twgl won't log the error when we provide a custom error callback, so log it ourselves
            console.error(newError);

            // For the error that we throw, just include the actual error from WebGL, not all the fancy
            // extras that twgl adds to the error messages.
            const match = newError.match(/\*\*\* Error compiling shader: ([\s\S]+)/);
            errorMessage = match ? match[1].trim() : newError;
        };

        const program = twgl.createProgramInfo(this._gl, [vsFullText, fsFullText], null, null, onError);
        if (!program) {
            throw new Error(`Failed to compile shader (mode ${drawMode}, effects ${effectBits}): ${errorMessage}`);
        }
        return program;
    }

    /**
     * Inject shader snippets for enabled custom effects into the sprite fragment shader.
     * @param {string} fragmentSource Base fragment source.
     * @param {int} effectBits Bitmask of enabled effects.
     * @returns {string} Fragment source with injected snippets.
     * @private
     */
    _injectEffectShaderSections (fragmentSource, effectBits) {
        const customUniforms = [];
        const customTexcoord = [];
        const customColor = [];

        const numEffects = ShaderManager.EFFECTS.length;
        for (let index = 0; index < numEffects; ++index) {
            const effectName = ShaderManager.EFFECTS[index];
            const effectInfo = ShaderManager.EFFECT_INFO[effectName];
            if ((effectBits & effectInfo.mask) === 0) continue;

            const shaderHooks = ShaderManager.CUSTOM_EFFECT_SHADER_HOOKS[effectName];
            if (!shaderHooks) continue;

            const ifdefStart = `#ifdef ENABLE_${effectName}`;
            const ifdefEnd = `#endif // ENABLE_${effectName}`;

            if (shaderHooks.fragmentUniforms) {
                customUniforms.push(ifdefStart, shaderHooks.fragmentUniforms, ifdefEnd);
            }
            if (shaderHooks.fragmentTexcoord) {
                customTexcoord.push(ifdefStart, shaderHooks.fragmentTexcoord, ifdefEnd);
            }
            if (shaderHooks.fragmentColor) {
                customColor.push(ifdefStart, shaderHooks.fragmentColor, ifdefEnd);
            }
        }

        return fragmentSource
            .replace('/* __CUSTOM_EFFECT_UNIFORMS__ */', customUniforms.join('\n'))
            .replace('/* __CUSTOM_EFFECT_TEXCOORD__ */', customTexcoord.join('\n'))
            .replace('/* __CUSTOM_EFFECT_COLOR__ */', customColor.join('\n'));
    }

    /**
     * Validate and register a custom effect globally.
     * @param {string} effectName Effect name.
     * @param {object} [effectInfo] Effect metadata and shader hook snippets.
     * @returns {string} The normalized effect name.
     */
    static registerEffect (effectName, effectInfo = {}) {
        effectInfo = effectInfo || {};
        if (typeof effectName !== 'string') {
            throw new Error('Effect name must be a string.');
        }

        const normalizedEffectName = effectName.trim().toLowerCase();
        if (!normalizedEffectName) {
            throw new Error('Effect name must not be empty.');
        }
        if (!/^[a-z][a-z0-9_]*$/.test(normalizedEffectName)) {
            throw new Error('Effect name must start with a letter and contain only [a-z0-9_].');
        }
        if (Object.prototype.hasOwnProperty.call(ShaderManager.EFFECT_INFO, normalizedEffectName)) {
            throw new Error(`Effect already exists: ${normalizedEffectName}`);
        }

        const converter = effectInfo.converter || (x => x);
        if (typeof converter !== 'function') {
            throw new Error(`Converter for effect ${normalizedEffectName} must be a function.`);
        }

        let mask = effectInfo.mask;
        if (typeof mask === 'undefined') {
            mask = ShaderManager._findFirstFreeEffectMask();
        }
        if (!ShaderManager._isValidEffectMask(mask)) {
            throw new Error(`Effect mask for ${normalizedEffectName} must be a power-of-two integer.`);
        }

        for (const name of ShaderManager.EFFECTS) {
            if (ShaderManager.EFFECT_INFO[name].mask === mask) {
                throw new Error(`Effect mask for ${normalizedEffectName} collides with existing effect ${name}.`);
            }
        }

        const uniformName = effectInfo.uniformName || `u_${normalizedEffectName}`;
        ShaderManager.EFFECT_INFO[normalizedEffectName] = {
            uniformName,
            mask,
            converter,
            shapeChanges: !!effectInfo.shapeChanges
        };
        ShaderManager.EFFECTS = Object.keys(ShaderManager.EFFECT_INFO);

        const fragmentUniforms = effectInfo.fragmentUniforms || '';
        const fragmentTexcoord = effectInfo.fragmentTexcoord || '';
        const fragmentColor = effectInfo.fragmentColor || '';
        if (fragmentUniforms || fragmentTexcoord || fragmentColor) {
            ShaderManager.CUSTOM_EFFECT_SHADER_HOOKS[normalizedEffectName] = {
                fragmentUniforms,
                fragmentTexcoord,
                fragmentColor
            };
        }

        return normalizedEffectName;
    }

    /**
     * @param {number} mask Candidate mask.
     * @returns {boolean} True if the mask is a power-of-two integer.
     * @private
     */
    static _isValidEffectMask (mask) {
        return Number.isInteger(mask) && mask > 0 && (mask & (mask - 1)) === 0;
    }

    /**
     * @returns {number} The first free power-of-two mask.
     * @private
     */
    static _findFirstFreeEffectMask () {
        const usedMasks = new Set();
        for (const effectName of ShaderManager.EFFECTS) {
            usedMasks.add(ShaderManager.EFFECT_INFO[effectName].mask);
        }

        for (let bit = 0; bit < 31; bit++) {
            const candidate = 1 << bit;
            if (!usedMasks.has(candidate)) {
                return candidate;
            }
        }

        throw new Error('No free shader effect masks are available.');
    }
}

/**
 * @typedef {object} ShaderManager.Effect
 * @prop {int} mask - The bit in 'effectBits' representing the effect.
 * @prop {function} converter - A conversion function which takes a Scratch value (generally in the range
 *   0..100 or -100..100) and maps it to a value useful to the shader. This
 *   mapping may not be reversible.
 * @prop {boolean} shapeChanges - Whether the effect could change the drawn shape.
 */

/**
 * Mapping of each effect name to info about that effect.
 * @enum {ShaderManager.Effect}
 */
ShaderManager.EFFECT_INFO = Object.assign({}, DEFAULT_EFFECT_INFO);

/**
 * The name of each supported effect.
 * @type {Array}
 */
ShaderManager.EFFECTS = Object.keys(ShaderManager.EFFECT_INFO);

/**
 * Optional shader hooks for effects registered at runtime.
 * @type {Object.<string, {fragmentUniforms: string, fragmentTexcoord: string, fragmentColor: string}>}
 */
ShaderManager.CUSTOM_EFFECT_SHADER_HOOKS = Object.create(null);

/**
 * The available draw modes.
 * @readonly
 * @enum {string}
 */
ShaderManager.DRAW_MODE = {
    /**
     * Draw normally. Its output will use premultiplied alpha.
     */
    default: 'default',

    /**
     * Draw with non-premultiplied alpha. Useful for reading pixels from GL into an ImageData object.
     */
    straightAlpha: 'straightAlpha',

    /**
     * Draw a silhouette using a solid color.
     */
    silhouette: 'silhouette',

    /**
     * Draw only the parts of the drawable which match a particular color.
     */
    colorMask: 'colorMask',

    /**
     * Draw a line with caps.
     */
    line: 'line',

    /**
     * Draw the background in a certain color. Must sometimes be used instead of gl.clear.
     */
    background: 'background'
};

module.exports = ShaderManager;
