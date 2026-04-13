const twgl = require('twgl.js');

const Rectangle = require('./Rectangle');
const RenderConstants = require('./RenderConstants');
const ShaderManager = require('./ShaderManager');
const EffectTransform = require('./EffectTransform');
const log = require('./util/log');

/**
 * An internal workspace for calculating texture locations from world vectors
 * this is REUSED for memory conservation reasons
 * @type {twgl.v3}
 */
const __isTouchingPosition = twgl.v3.create();
const __clipMaskTouchingPosition = twgl.v3.create();
const FLOATING_POINT_ERROR_ALLOWANCE = 1e-6;
const __effectBoundsMatrix = twgl.m4.identity();
const __clipMaskBounds = new Rectangle();

/**
 * Convert a scratch space location into a texture space float.  Uses the
 * internal __isTouchingPosition as a return value, so this should be copied
 * if you ever need to get two local positions and store both.  Requires that
 * the drawable inverseMatrix is up to date.
 *
 * @param {Drawable} drawable The drawable to get the inverse matrix and uniforms from
 * @param {twgl.v3} vec [x,y] scratch space vector
 * @return {twgl.v3} [x,y] texture space float vector - transformed by effects and matrix
 */
const getLocalPosition = (drawable, vec) => {
    // Transfrom from world coordinates to Drawable coordinates.
    const localPosition = __isTouchingPosition;
    const v0 = vec[0];
    const v1 = vec[1];
    const m = drawable._inverseMatrix;
    // var v2 = v[2];
    const d = (v0 * m[3]) + (v1 * m[7]) + m[15];
    // The RenderWebGL quad flips the texture's X axis. So rendered bottom
    // left is 1, 0 and the top right is 0, 1. Flip the X axis so
    // localPosition matches that transformation.
    localPosition[0] = 0.5 - (((v0 * m[0]) + (v1 * m[4]) + m[12]) / d);
    localPosition[1] = (((v0 * m[1]) + (v1 * m[5]) + m[13]) / d) + 0.5;
    // Fix floating point issues near 0. Filed https://github.com/LLK/scratch-render/issues/688 that
    // they're happening in the first place.
    // TODO: Check if this can be removed after render pull 479 is merged
    if (Math.abs(localPosition[0]) < FLOATING_POINT_ERROR_ALLOWANCE) localPosition[0] = 0;
    if (Math.abs(localPosition[1]) < FLOATING_POINT_ERROR_ALLOWANCE) localPosition[1] = 0;

    // Apply texture effect transform if the localPosition is within the drawable's space,
    // and any effects are currently active.
    if (drawable.enabledEffects !== 0 &&
        (localPosition[0] >= 0 && localPosition[0] < 1) &&
        (localPosition[1] >= 0 && localPosition[1] < 1)) {

        EffectTransform.transformPoint(drawable, localPosition, localPosition);
    }
    return localPosition;
};

const getClipMaskLocalPosition = (drawable, vec) => {
    const localPosition = __clipMaskTouchingPosition;
    const v0 = vec[0];
    const v1 = vec[1];
    const m = drawable._clipMaskInverseMatrix;
    const d = (v0 * m[3]) + (v1 * m[7]) + m[15];

    localPosition[0] = 0.5 - (((v0 * m[0]) + (v1 * m[4]) + m[12]) / d);
    localPosition[1] = (((v0 * m[1]) + (v1 * m[5]) + m[13]) / d) + 0.5;

    if (Math.abs(localPosition[0]) < FLOATING_POINT_ERROR_ALLOWANCE) localPosition[0] = 0;
    if (Math.abs(localPosition[1]) < FLOATING_POINT_ERROR_ALLOWANCE) localPosition[1] = 0;

    return localPosition;
};

const isTouchingClipMask = (drawable, vec) => {
    const clipMaskSkin = drawable._clipMaskSkin;
    if (!clipMaskSkin) {
        return true;
    }

    const localPosition = getClipMaskLocalPosition(drawable, vec);
    if (localPosition[0] < 0 || localPosition[1] < 0 ||
        localPosition[0] > 1 || localPosition[1] > 1) {
        return false;
    }

    if (clipMaskSkin.useNearest(drawable._scale, drawable)) {
        return clipMaskSkin.isTouchingNearest(localPosition);
    }

    return clipMaskSkin.isTouchingLinear(localPosition);
};

class Drawable {
    /**
     * An object which can be drawn by the renderer.
     * @todo double-buffer all rendering state (position, skin, effects, etc.)
     * @param {!int} id - This Drawable's unique ID.
     * @param {!RenderWebGL} renderer - The renderer that created this Drawable
     * @constructor
     */
    constructor (id, renderer) {
        /** @type {!int} */
        this._id = id;
        this._renderer = renderer;

        /**
         * The uniforms to be used by the vertex and pixel shaders.
         * Some of these are used by other parts of the renderer as well.
         * @type {Object.<string,*>}
         * @private
         */
        this._uniforms = {
            /**
             * The model matrix, to concat with projection at draw time.
             * @type {module:twgl/m4.Mat4}
             */
            u_modelMatrix: twgl.m4.identity(),

            /**
             * Extra normalized padding around the sprite quad for effects which render outside the base bounds.
             * @type {Array<number>}
             */
            u_effectPadding: [0, 0],

            /**
             * Whether this drawable should be clipped by a secondary skin.
             * @type {number}
             */
            u_hasMask: 0,

            /**
             * Inverse model matrix for the current clip mask skin.
             * @type {module:twgl/m4.Mat4}
             */
            u_maskInverseMatrix: twgl.m4.identity(),

            /**
             * Whether this drawable has a stage-coordinate clipping rectangle.
             * @type {number}
             */
            u_hasClipBox: 0,

            /**
             * Stage-coordinate clipping rectangle [x1, y1, x2, y2].
             * @type {Array<number>}
             */
            u_clipBox: [0, 0, 0, 0],

            /**
             * The color to use in the silhouette draw mode.
             * @type {Array<number>}
             */
            u_silhouetteColor: Drawable.color4fFromID(this._id)
        };

        // Effect values are uniforms too
        const numEffects = ShaderManager.EFFECTS.length;
        for (let index = 0; index < numEffects; ++index) {
            const effectName = ShaderManager.EFFECTS[index];
            const effectInfo = ShaderManager.EFFECT_INFO[effectName];
            const converter = effectInfo.converter;
            this._uniforms[effectInfo.uniformName] = converter(0);
        }

        this._position = twgl.v3.create(0, 0);
        this._scale = twgl.v3.create(100, 100);
        this._skew = twgl.v3.create(0, 0);
        this._effectPadding = twgl.v3.create(0, 0);
        this._clipMaskModelMatrix = twgl.m4.identity();
        this._clipMaskInverseMatrix = twgl.m4.identity();
        this._clipMaskSkin = null;
        this._clipMaskPosition = null; // null means follow sprite
        this._direction = 90;
        this._transformDirty = true;
        this._clipMaskTransformDirty = true;
        this._rotationMatrix = twgl.m4.identity();
        this._rotationTransformDirty = true;
        this._rotationAdjusted = twgl.v3.create();
        this._rotationCenterDirty = true;
        this._skinScale = twgl.v3.create(0, 0, 0);
        this._skinScaleDirty = true;
        this._inverseMatrix = twgl.m4.identity();
        this._inverseTransformDirty = true;
        this._visible = true;

        /** A bitmask identifying which effects are currently in use.
         * @readonly
         * @type {int} */
        this.enabledEffects = 0;
        this._effectRawValues = Object.create(null);

        /** @todo move convex hull functionality, maybe bounds functionality overall, to Skin classes */
        this._convexHullPoints = null;
        this._convexHullDirty = true;

        // The precise bounding box will be from the transformed convex hull points,
        // so initialize the array of transformed hull points in setConvexHullPoints.
        // Initializing it once per convex hull recalculation avoids unnecessary creation of twgl.v3 objects.
        this._transformedHullPoints = null;
        this._transformedHullDirty = true;

        this._skinWasAltered = this._skinWasAltered.bind(this);

        this.isTouching = this._isTouchingNever;

        this._highQuality = false;

        /**
         * If false, this drawable will be ignored by pick() by default.
         * The drawable may still be considered by pick() if its ID is explicitly given to pick().
         */
        this.interactive = true;
    }

    setHighQuality (highQuality) {
        this._highQuality = highQuality;
    }

    /**
     * Dispose of this Drawable. Do not use it after calling this method.
     */
    dispose () {
        // Use the setter: disconnect events
        this.skin = null;
    }

    /**
     * Mark this Drawable's transform as dirty.
     * It will be recalculated next time it's needed.
     */
    setTransformDirty () {
        this._transformDirty = true;
        this._clipMaskTransformDirty = true;
        this._inverseTransformDirty = true;
        this._transformedHullDirty = true;
    }

    /**
     * @returns {number} The ID for this Drawable.
     */
    get id () {
        return this._id;
    }

    /**
     * @returns {Skin} the current skin for this Drawable.
     */
    get skin () {
        return this._skin;
    }

    /**
     * @returns {?Skin} the current clip mask skin for this Drawable.
     */
    get clipMaskSkin () {
        return this._clipMaskSkin;
    }

    /**
     * @param {Skin} newSkin - A new Skin for this Drawable.
     */
    set skin (newSkin) {
        if (this._skin !== newSkin) {
            this._skin = newSkin;
            this._skinWasAltered();
        }
    }

    /**
     * @returns {Array<number>} the current scaling percentages applied to this Drawable. [100,100] is normal size.
     */
    get scale () {
        return [this._scale[0], this._scale[1]];
    }

    /**
     * @returns {Array<number>} the current skew angles in degrees [skewX, skewY].
     */
    get skew () {
        return [this._skew[0], this._skew[1]];
    }

    /**
     * @returns {object.<string, *>} the shader uniforms to be used when rendering this Drawable.
     */
    getUniforms () {
        if (this._transformDirty) {
            this._calculateTransform();
        }
        this._updateClipMaskMatrix();
        return this._uniforms;
    }

    /**
     * @returns {boolean} whether this Drawable is visible.
     */
    getVisible () {
        return this._visible;
    }

    /**
     * Update the position if it is different. Marks the transform as dirty.
     * @param {Array.<number>} position A new position.
     */
    updatePosition (position) {
        if (this._position[0] !== position[0] ||
            this._position[1] !== position[1]) {
            if (this._highQuality) {
                this._position[0] = position[0];
                this._position[1] = position[1];
            } else {
                this._position[0] = Math.round(position[0]);
                this._position[1] = Math.round(position[1]);
            }
            this._renderer.dirty = true;
            this.setTransformDirty();
        }
    }

    /**
     * Update the direction if it is different. Marks the transform as dirty.
     * @param {number} direction A new direction.
     */
    updateDirection (direction) {
        if (this._direction !== direction) {
            this._direction = direction;
            this._renderer.dirty = true;
            this._rotationTransformDirty = true;
            this.setTransformDirty();
        }
    }

    /**
     * Update the scale if it is different. Marks the transform as dirty.
     * @param {Array.<number>} scale A new scale.
     */
    updateScale (scale) {
        if (this._scale[0] !== scale[0] ||
            this._scale[1] !== scale[1]) {
            this._scale[0] = scale[0];
            this._scale[1] = scale[1];
            this._renderer.dirty = true;
            this._rotationCenterDirty = true;
            this._skinScaleDirty = true;
            this.setTransformDirty();
        }
    }

    /**
     * Update the skew if it is different. Marks the transform as dirty.
     * @param {Array.<number>} skew New skew angles in degrees [skewX, skewY].
     */
    updateSkew (skew) {
        if (this._skew[0] !== skew[0] ||
            this._skew[1] !== skew[1]) {
            this._skew[0] = skew[0];
            this._skew[1] = skew[1];
            this._renderer.dirty = true;
            this.setTransformDirty();
        }
    }

    /**
     * Update or clear the stage-coordinate clipping rectangle.
     * @param {?Array<number>} box [x1, y1, x2, y2] in stage pixels, or null to clear.
     */
    updateClipBox (box) {
        if (box) {
            this._uniforms.u_hasClipBox = 1;
            this._uniforms.u_clipBox[0] = box[0];
            this._uniforms.u_clipBox[1] = box[1];
            this._uniforms.u_clipBox[2] = box[2];
            this._uniforms.u_clipBox[3] = box[3];
        } else {
            this._uniforms.u_hasClipBox = 0;
        }
        this._renderer.dirty = true;
    }

    /**
     * Update the clip mask skin if it is different.
     * @param {?Skin} clipMaskSkin A new clip mask skin.
     */
    updateClipMaskSkin (clipMaskSkin) {
        if (this._clipMaskSkin !== clipMaskSkin) {
            this._clipMaskSkin = clipMaskSkin;
            this._uniforms.u_hasMask = clipMaskSkin ? 1 : 0;
            this._renderer.dirty = true;
            this.setConvexHullDirty();
            this.setTransformDirty();
        }
    }

    /**
     * Set or clear the stage-coordinate position for the clip mask.
     * Pass null to make the mask follow the sprite.
     * @param {?Array<number>} position [x, y] in stage coordinates, or null.
     */
    updateClipMaskPosition (position) {
        this._clipMaskPosition = position ? [position[0], position[1]] : null;
        this._clipMaskTransformDirty = true;
        this._renderer.dirty = true;
    }

    /**
     * Update visibility if it is different. Marks the convex hull as dirty.
     * @param {boolean} visible A new visibility state.
     */
    updateVisible (visible) {
        if (this._visible !== visible) {
            this._visible = visible;
            this._renderer.dirty = true;
            this.setConvexHullDirty();
        }
    }

    /**
     * Update an effect. Marks the convex hull as dirty if the effect changes shape.
     * @param {string} effectName The name of the effect.
     * @param {number} rawValue A new effect value.
     */
    updateEffect (effectName, rawValue) {
        this._renderer.dirty = true;
        const effectInfo = ShaderManager.EFFECT_INFO[effectName];
        if (!effectInfo) {
            log.warn(`Could not update unknown effect: ${effectName}`);
            return;
        }
        if (rawValue) {
            this.enabledEffects |= effectInfo.mask;
        } else {
            this.enabledEffects &= ~effectInfo.mask;
        }
        const converter = effectInfo.converter;
        this._effectRawValues[effectName] = rawValue;
        this._uniforms[effectInfo.uniformName] = converter(rawValue);
        if (this._recalculateEffectPadding()) {
            this.setTransformDirty();
            this.setConvexHullDirty();
        }
        if (effectInfo.shapeChanges) {
            this.setConvexHullDirty();
        }
    }

    /**
     * Recalculate aggregate padding needed for active effects.
     * @returns {boolean} True if the padding changed.
     * @private
     */
    _recalculateEffectPadding () {
        let paddingX = 0;
        let paddingY = 0;

        const numEffects = ShaderManager.EFFECTS.length;
        for (let index = 0; index < numEffects; ++index) {
            const effectName = ShaderManager.EFFECTS[index];
            const effectInfo = ShaderManager.EFFECT_INFO[effectName];
            if (!effectInfo || !effectInfo.boundsPadding) continue;

            const rawValue = this._effectRawValues[effectName] || 0;
            if (!rawValue) continue;

            const paddingValue = typeof effectInfo.boundsPadding === 'function' ?
                effectInfo.boundsPadding(rawValue) : effectInfo.boundsPadding;
            const normalizedPadding = Drawable._normalizeEffectPadding(paddingValue, this.skin);
            paddingX = Math.max(paddingX, normalizedPadding[0]);
            paddingY = Math.max(paddingY, normalizedPadding[1]);
        }

        const currentPadding = this._effectPadding;
        if (currentPadding[0] === paddingX && currentPadding[1] === paddingY) {
            return false;
        }

        currentPadding[0] = paddingX;
        currentPadding[1] = paddingY;
        this._uniforms.u_effectPadding[0] = paddingX;
        this._uniforms.u_effectPadding[1] = paddingY;
        return true;
    }

    /**
     * Update the position, direction, scale, or effect properties of this Drawable.
     * @deprecated Use specific update* methods instead.
     * @param {object.<string,*>} properties The new property values to set.
     */
    updateProperties (properties) {
        if ('position' in properties) {
            this.updatePosition(properties.position);
        }
        if ('direction' in properties) {
            this.updateDirection(properties.direction);
        }
        if ('scale' in properties) {
            this.updateScale(properties.scale);
        }
        if ('skew' in properties) {
            this.updateSkew(properties.skew);
        } else if ('skewX' in properties || 'skewY' in properties) {
            this.updateSkew([
                'skewX' in properties ? properties.skewX : this._skew[0],
                'skewY' in properties ? properties.skewY : this._skew[1]
            ]);
        }
        if ('visible' in properties) {
            this.updateVisible(properties.visible);
        }
        if ('clipMaskSkin' in properties) {
            this.updateClipMaskSkin(properties.clipMaskSkin);
        }
        const numEffects = ShaderManager.EFFECTS.length;
        for (let index = 0; index < numEffects; ++index) {
            const effectName = ShaderManager.EFFECTS[index];
            if (effectName in properties) {
                this.updateEffect(effectName, properties[effectName]);
            }
        }
    }

    /**
     * Calculate the transform to use when rendering this Drawable.
     * @private
     */
    _calculateTransform () {
        if (this._rotationTransformDirty) {
            const rotation = (270 - this._direction) * Math.PI / 180;

            // Calling rotationZ sets the destination matrix to a rotation
            // around the Z axis setting matrix components 0, 1, 4 and 5 with
            // cosine and sine values of the rotation.
            // twgl.m4.rotationZ(rotation, this._rotationMatrix);

            // twgl assumes the last value set to the matrix was anything.
            // Drawable knows, it was another rotationZ matrix, so we can skip
            // assigning the values that will never change.
            const c = Math.cos(rotation);
            const s = Math.sin(rotation);
            this._rotationMatrix[0] = c;
            this._rotationMatrix[1] = s;
            // this._rotationMatrix[2] = 0;
            // this._rotationMatrix[3] = 0;
            this._rotationMatrix[4] = -s;
            this._rotationMatrix[5] = c;
            // this._rotationMatrix[6] = 0;
            // this._rotationMatrix[7] = 0;
            // this._rotationMatrix[8] = 0;
            // this._rotationMatrix[9] = 0;
            // this._rotationMatrix[10] = 1;
            // this._rotationMatrix[11] = 0;
            // this._rotationMatrix[12] = 0;
            // this._rotationMatrix[13] = 0;
            // this._rotationMatrix[14] = 0;
            // this._rotationMatrix[15] = 1;

            this._rotationTransformDirty = false;
        }

        // Adjust rotation center relative to the skin.
        if (this._rotationCenterDirty && this.skin !== null) {
            // twgl version of the following in function work.
            // let rotationAdjusted = twgl.v3.subtract(
            //     this.skin.rotationCenter,
            //     twgl.v3.divScalar(this.skin.size, 2, this._rotationAdjusted),
            //     this._rotationAdjusted
            // );
            // rotationAdjusted = twgl.v3.multiply(
            //     rotationAdjusted, this._scale, rotationAdjusted
            // );
            // rotationAdjusted = twgl.v3.divScalar(
            //     rotationAdjusted, 100, rotationAdjusted
            // );
            // rotationAdjusted[1] *= -1; // Y flipped to Scratch coordinate.
            // rotationAdjusted[2] = 0; // Z coordinate is 0.

            // Locally assign rotationCenter and skinSize to keep from having
            // the Skin getter properties called twice while locally assigning
            // their components for readability.
            const rotationCenter = this.skin.rotationCenter;
            const skinSize = this.skin.size;
            const center0 = rotationCenter[0];
            const center1 = rotationCenter[1];
            const skinSize0 = skinSize[0];
            const skinSize1 = skinSize[1];
            const scale0 = this._scale[0];
            const scale1 = this._scale[1];

            const rotationAdjusted = this._rotationAdjusted;
            rotationAdjusted[0] = (center0 - (skinSize0 / 2)) * scale0 / 100;
            rotationAdjusted[1] = ((center1 - (skinSize1 / 2)) * scale1 / 100) * -1;
            // rotationAdjusted[2] = 0;

            this._rotationCenterDirty = false;
        }

        if (this._skinScaleDirty && this.skin !== null) {
            // twgl version of the following in function work.
            // const scaledSize = twgl.v3.divScalar(
            //     twgl.v3.multiply(this.skin.size, this._scale),
            //     100
            // );
            // // was NaN because the vectors have only 2 components.
            // scaledSize[2] = 0;

            // Locally assign skinSize to keep from having the Skin getter
            // properties called twice.
            const skinSize = this.skin.size;
            const scaledSize = this._skinScale;
            scaledSize[0] = skinSize[0] * this._scale[0] / 100;
            scaledSize[1] = skinSize[1] * this._scale[1] / 100;
            // scaledSize[2] = 0;

            this._skinScaleDirty = false;
        }

        const modelMatrix = this._uniforms.u_modelMatrix;

        // twgl version of the following in function work.
        // twgl.m4.identity(modelMatrix);
        // twgl.m4.translate(modelMatrix, this._position, modelMatrix);
        // twgl.m4.multiply(modelMatrix, this._rotationMatrix, modelMatrix);
        // twgl.m4.translate(modelMatrix, this._rotationAdjusted, modelMatrix);
        // twgl.m4.scale(modelMatrix, scaledSize, modelMatrix);

        // Drawable configures a 3D matrix for drawing in WebGL, but most values
        // will never be set because the inputs are on the X and Y position axis
        // and the Z rotation axis. Drawable can bring the work inside
        // _calculateTransform and greatly reduce the ammount of math and array
        // assignments needed.

        const scale0 = this._skinScale[0];
        const scale1 = this._skinScale[1];
        const skewRadians0 = this._skew[0] * Math.PI / 180;
        const skewRadians1 = this._skew[1] * Math.PI / 180;
        const skewFactor0 = Math.tan(skewRadians0);
        const skewFactor1 = Math.tan(skewRadians1);
        const scaledSkew0 = scale0 * skewFactor0;
        const scaledSkew1 = scale1 * skewFactor1;
        const rotation00 = this._rotationMatrix[0];
        const rotation01 = this._rotationMatrix[1];
        const rotation10 = this._rotationMatrix[4];
        const rotation11 = this._rotationMatrix[5];
        const adjusted0 = this._rotationAdjusted[0];
        const adjusted1 = this._rotationAdjusted[1];
        const position0 = this._position[0];
        const position1 = this._position[1];

        // Commented assignments show what the values are when the matrix was
        // instantiated. Those values will never change so they do not need to
        // be reassigned.
        modelMatrix[0] = (scale0 * rotation00) + (scaledSkew1 * rotation10);
        modelMatrix[1] = (scale0 * rotation01) + (scaledSkew1 * rotation11);
        // modelMatrix[2] = 0;
        // modelMatrix[3] = 0;
        modelMatrix[4] = (scaledSkew0 * rotation00) + (scale1 * rotation10);
        modelMatrix[5] = (scaledSkew0 * rotation01) + (scale1 * rotation11);
        // modelMatrix[6] = 0;
        // modelMatrix[7] = 0;
        // modelMatrix[8] = 0;
        // modelMatrix[9] = 0;
        // modelMatrix[10] = 1;
        // modelMatrix[11] = 0;
        modelMatrix[12] = (rotation00 * adjusted0) + (rotation10 * adjusted1) + position0;
        modelMatrix[13] = (rotation01 * adjusted0) + (rotation11 * adjusted1) + position1;
        // modelMatrix[14] = 0;
        // modelMatrix[15] = 1;

        this._transformDirty = false;
    }

    /**
     * Update the cached inverse matrix for the current clip mask skin.
     * @private
     */
    _updateClipMaskMatrix () {
        if (!this._clipMaskSkin) {
            this._uniforms.u_hasMask = 0;
            this._clipMaskTransformDirty = false;
            return;
        }

        if (!this._clipMaskTransformDirty) {
            return;
        }

        if (this._rotationTransformDirty) {
            const rotation = (270 - this._direction) * Math.PI / 180;
            const c = Math.cos(rotation);
            const s = Math.sin(rotation);
            this._rotationMatrix[0] = c;
            this._rotationMatrix[1] = s;
            this._rotationMatrix[4] = -s;
            this._rotationMatrix[5] = c;
            this._rotationTransformDirty = false;
        }

        const maskSkin = this._clipMaskSkin;
        const rotationCenter = maskSkin.rotationCenter;
        const skinSize = maskSkin.size;
        const scalePercent0 = this._scale[0];
        const scalePercent1 = this._scale[1];
        const maskScale0 = skinSize[0] * scalePercent0 / 100;
        const maskScale1 = skinSize[1] * scalePercent1 / 100;
        const adjusted0 = (rotationCenter[0] - (skinSize[0] / 2)) * scalePercent0 / 100;
        const adjusted1 = ((rotationCenter[1] - (skinSize[1] / 2)) * scalePercent1 / 100) * -1;
        const skewRadians0 = this._skew[0] * Math.PI / 180;
        const skewRadians1 = this._skew[1] * Math.PI / 180;
        const skewFactor0 = Math.tan(skewRadians0);
        const skewFactor1 = Math.tan(skewRadians1);
        const scaledSkew0 = maskScale0 * skewFactor0;
        const scaledSkew1 = maskScale1 * skewFactor1;
        const rotation00 = this._rotationMatrix[0];
        const rotation01 = this._rotationMatrix[1];
        const rotation10 = this._rotationMatrix[4];
        const rotation11 = this._rotationMatrix[5];
        const maskPos = this._clipMaskPosition;
        const position0 = maskPos ? maskPos[0] : this._position[0];
        const position1 = maskPos ? maskPos[1] : this._position[1];
        const modelMatrix = this._clipMaskModelMatrix;

        modelMatrix[0] = (maskScale0 * rotation00) + (scaledSkew1 * rotation10);
        modelMatrix[1] = (maskScale0 * rotation01) + (scaledSkew1 * rotation11);
        modelMatrix[4] = (scaledSkew0 * rotation00) + (maskScale1 * rotation10);
        modelMatrix[5] = (scaledSkew0 * rotation01) + (maskScale1 * rotation11);
        modelMatrix[12] = (rotation00 * adjusted0) + (rotation10 * adjusted1) + position0;
        modelMatrix[13] = (rotation01 * adjusted0) + (rotation11 * adjusted1) + position1;

        const inverse = this._clipMaskInverseMatrix;
        twgl.m4.copy(modelMatrix, inverse);
        inverse[10] = 1;
        twgl.m4.inverse(inverse, inverse);
        twgl.m4.copy(inverse, this._uniforms.u_maskInverseMatrix);

        this._uniforms.u_hasMask = 1;
        this._clipMaskTransformDirty = false;
    }

    /**
     * Intersect bounds with the current clip mask AABB.
     * @param {!Rectangle} bounds Bounds to intersect.
     * @returns {!Rectangle} Intersected bounds.
     * @private
     */
    _applyClipMaskBounds (bounds) {
        if (!this._clipMaskSkin) {
            return bounds;
        }

        this._updateClipMaskMatrix();
        __clipMaskBounds.initFromModelMatrix(this._clipMaskModelMatrix);

        if (!bounds.intersects(__clipMaskBounds)) {
            bounds.initFromBounds(this._position[0], this._position[0], this._position[1], this._position[1]);
            return bounds;
        }

        return Rectangle.intersect(bounds, __clipMaskBounds, bounds);
    }

    /**
     * Whether the Drawable needs convex hull points provided by the renderer.
     * @return {boolean} True when no convex hull known, or it's dirty.
     */
    needsConvexHullPoints () {
        return !this._convexHullPoints || this._convexHullDirty || this._convexHullPoints.length === 0;
    }

    /**
     * Set the convex hull to be dirty.
     * Do this whenever the Drawable's shape has possibly changed.
     */
    setConvexHullDirty () {
        this._convexHullDirty = true;
    }

    /**
     * Set the convex hull points for the Drawable.
     * @param {Array<Array<number>>} points Convex hull points, as [[x, y], ...]
     */
    setConvexHullPoints (points) {
        this._convexHullPoints = points;
        this._convexHullDirty = false;

        // Re-create the "transformed hull points" array.
        // We only do this when the hull points change to avoid unnecessary allocations and GC.
        this._transformedHullPoints = [];
        for (let i = 0; i < points.length; i++) {
            this._transformedHullPoints.push(twgl.v3.create());
        }
        this._transformedHullDirty = true;
    }

    /**
     * @function
     * @name isTouching
     * Check if the world position touches the skin.
     * The caller is responsible for ensuring this drawable's inverse matrix & its skin's silhouette are up-to-date.
     * @see updateCPURenderAttributes
     * @param {twgl.v3} vec World coordinate vector.
     * @return {boolean} True if the world position touches the skin.
     */

    // `updateCPURenderAttributes` sets this Drawable instance's `isTouching` method
    // to one of the following three functions:
    // If this drawable has no skin, set it to `_isTouchingNever`.
    // Otherwise, if this drawable uses nearest-neighbor scaling at its current scale, set it to `_isTouchingNearest`.
    // Otherwise, set it to `_isTouchingLinear`.
    // This allows several checks to be moved from the `isTouching` function to `updateCPURenderAttributes`.

    // eslint-disable-next-line no-unused-vars
    _isTouchingNever (vec) {
        return false;
    }

    _isTouchingNearest (vec) {
        return this.skin.isTouchingNearest(getLocalPosition(this, vec)) && isTouchingClipMask(this, vec);
    }

    _isTouchingLinear (vec) {
        return this.skin.isTouchingLinear(getLocalPosition(this, vec)) && isTouchingClipMask(this, vec);
    }

    /**
     * Get the precise bounds for a Drawable.
     * This function applies the transform matrix to the known convex hull,
     * and then finds the minimum box along the axes.
     * Before calling this, ensure the renderer has updated convex hull points.
     * @param {?Rectangle} result optional destination for bounds calculation
     * @return {!Rectangle} Bounds for a tight box around the Drawable.
     */
    getBounds (result) {
        if (this._effectPadding[0] !== 0 || this._effectPadding[1] !== 0) {
            return this.getAABB(result);
        }
        if (this.needsConvexHullPoints()) {
            throw new Error('Needs updated convex hull points before bounds calculation.');
        }
        if (this._transformDirty) {
            this._calculateTransform();
        }
        const transformedHullPoints = this._getTransformedHullPoints();
        // Search through transformed points to generate box on axes.
        result = result || new Rectangle();
        result.initFromPointsAABB(transformedHullPoints);
        return this._applyClipMaskBounds(result);
    }

    /**
     * Get the precise bounds for the upper 8px slice of the Drawable.
     * Used for calculating where to position a text bubble.
     * Before calling this, ensure the renderer has updated convex hull points.
     * @param {?Rectangle} result optional destination for bounds calculation
     * @return {!Rectangle} Bounds for a tight box around a slice of the Drawable.
     */
    getBoundsForBubble (result) {
        if (this._effectPadding[0] !== 0 || this._effectPadding[1] !== 0) {
            return this.getAABB(result);
        }
        if (this.needsConvexHullPoints()) {
            throw new Error('Needs updated convex hull points before bubble bounds calculation.');
        }
        if (this._transformDirty) {
            this._calculateTransform();
        }
        const slice = 8; // px, how tall the top slice to measure should be.
        const transformedHullPoints = this._getTransformedHullPoints();
        const maxY = Math.max.apply(null, transformedHullPoints.map(p => p[1]));
        const filteredHullPoints = transformedHullPoints.filter(p => p[1] > maxY - slice);
        // Search through filtered points to generate box on axes.
        result = result || new Rectangle();
        result.initFromPointsAABB(filteredHullPoints);
        return this._applyClipMaskBounds(result);
    }

    /**
     * Get the rough axis-aligned bounding box for the Drawable.
     * Calculated by transforming the skin's bounds.
     * Note that this is less precise than the box returned by `getBounds`,
     * which is tightly snapped to account for a Drawable's transparent regions.
     * `getAABB` returns a much less accurate bounding box, but will be much
     * faster to calculate so may be desired for quick checks/optimizations.
     * @param {?Rectangle} result optional destination for bounds calculation
     * @return {!Rectangle} Rough axis-aligned bounding box for Drawable.
     */
    getAABB (result) {
        if (this._transformDirty) {
            this._calculateTransform();
        }
        const tm = this._getBoundsModelMatrix();
        result = result || new Rectangle();
        result.initFromModelMatrix(tm);
        return this._applyClipMaskBounds(result);
    }

    /**
     * Return the best Drawable bounds possible without performing graphics queries.
     * I.e., returns the tight bounding box when the convex hull points are already
     * known, but otherwise return the rough AABB of the Drawable.
     * @param {?Rectangle} result optional destination for bounds calculation
     * @return {!Rectangle} Bounds for the Drawable.
     */
    getFastBounds (result) {
        if (!this.needsConvexHullPoints()) {
            return this.getBounds(result);
        }
        return this.getAABB(result);
    }

    /**
     * Transform all the convex hull points by the current Drawable's
     * transform. This allows us to skip recalculating the convex hull
     * for many Drawable updates, including translation, rotation, scaling.
     * @return {!Array.<!Array.number>} Array of glPoints which are Array<x, y>
     * @private
     */
    _getTransformedHullPoints () {
        if (!this._transformedHullDirty) {
            return this._transformedHullPoints;
        }

        const projection = twgl.m4.ortho(-1, 1, -1, 1, -1, 1);
        const skinSize = this.skin.size;
        const halfXPixel = 1 / skinSize[0] / 2;
        const halfYPixel = 1 / skinSize[1] / 2;
        const tm = twgl.m4.multiply(this._uniforms.u_modelMatrix, projection);
        for (let i = 0; i < this._convexHullPoints.length; i++) {
            const point = this._convexHullPoints[i];
            const dstPoint = this._transformedHullPoints[i];

            dstPoint[0] = 0.5 + (-point[0] / skinSize[0]) - halfXPixel;
            dstPoint[1] = (point[1] / skinSize[1]) - 0.5 + halfYPixel;
            twgl.m4.transformPoint(tm, dstPoint, dstPoint);
        }

        this._transformedHullDirty = false;

        return this._transformedHullPoints;
    }

    /**
     * Update the transform matrix and calculate it's inverse for collision
     * and local texture position purposes.
     */
    updateMatrix () {
        if (this._transformDirty) {
            this._calculateTransform();
        }
        // Get the inverse of the model matrix or update it.
        if (this._inverseTransformDirty) {
            const inverse = this._inverseMatrix;
            twgl.m4.copy(this._uniforms.u_modelMatrix, inverse);
            // The normal matrix uses a z scaling of 0 causing model[10] to be
            // 0. Getting a 4x4 inverse is impossible without a scaling in x, y,
            // and z.
            inverse[10] = 1;
            twgl.m4.inverse(inverse, inverse);
            this._inverseTransformDirty = false;
        }
    }

    /**
     * Get the model matrix used for bounds calculations, including any extra effect padding.
     * @returns {module:twgl/m4.Mat4} Model matrix for bounds.
     * @private
     */
    _getBoundsModelMatrix () {
        const paddingX = this._effectPadding[0];
        const paddingY = this._effectPadding[1];
        const tm = this._uniforms.u_modelMatrix;
        if (paddingX === 0 && paddingY === 0) {
            return tm;
        }

        const scaleX = 1 + (paddingX * 2);
        const scaleY = 1 + (paddingY * 2);
        twgl.m4.copy(tm, __effectBoundsMatrix);
        __effectBoundsMatrix[0] *= scaleX;
        __effectBoundsMatrix[1] *= scaleX;
        __effectBoundsMatrix[4] *= scaleY;
        __effectBoundsMatrix[5] *= scaleY;
        return __effectBoundsMatrix;
    }

    /**
     * Update everything necessary to render this drawable on the CPU.
     */
    updateCPURenderAttributes () {
        this.updateMatrix();
        // CPU rendering always occurs at the "native" size, so no need to scale up this._scale
        if (this.skin) {
            this.skin.updateSilhouette(this._scale);
            if (this._clipMaskSkin) {
                this._updateClipMaskMatrix();
                this._clipMaskSkin.updateSilhouette(this._scale);
            }

            if (this.skin.useNearest(this._scale, this)) {
                this.isTouching = this._isTouchingNearest;
            } else {
                this.isTouching = this._isTouchingLinear;
            }
        } else {
            log.warn(`Could not find skin for drawable with id: ${this._id}`);

            this.isTouching = this._isTouchingNever;
        }
    }

    /**
     * Respond to an internal change in the current Skin.
     */
    _skinWasAltered () {
        this._renderer.dirty = true;
        this._rotationCenterDirty = true;
        this._skinScaleDirty = true;
        this.setConvexHullDirty();
        this.setTransformDirty();
    }

    /**
     * Calculate a color to represent the given ID number. At least one component of
     * the resulting color will be non-zero if the ID is not RenderConstants.ID_NONE.
     * @param {int} id The ID to convert.
     * @returns {Array<number>} An array of [r,g,b,a], each component in the range [0,1].
     */
    static color4fFromID (id) {
        id -= RenderConstants.ID_NONE;
        const r = ((id >> 0) & 255) / 255.0;
        const g = ((id >> 8) & 255) / 255.0;
        const b = ((id >> 16) & 255) / 255.0;
        return [r, g, b, 1.0];
    }

    /**
     * Calculate the ID number represented by the given color. If all components of
     * the color are zero, the result will be RenderConstants.ID_NONE; otherwise the result
     * will be a valid ID.
     * @param {int} r The red value of the color, in the range [0,255].
     * @param {int} g The green value of the color, in the range [0,255].
     * @param {int} b The blue value of the color, in the range [0,255].
     * @returns {int} The ID represented by that color.
     */
    static color3bToID (r, g, b) {
        let id;
        id = (r & 255) << 0;
        id |= (g & 255) << 8;
        id |= (b & 255) << 16;
        return id + RenderConstants.ID_NONE;
    }

    /**
     * Sample a color from a drawable's texture.
     * The caller is responsible for ensuring this drawable's inverse matrix & its skin's silhouette are up-to-date.
     * @see updateCPURenderAttributes
     * @param {twgl.v3} vec The scratch space [x,y] vector
     * @param {Drawable} drawable The drawable to sample the texture from
     * @param {Uint8ClampedArray} dst The "color4b" representation of the texture at point.
     * @param {number} [effectMask] A bitmask for which effects to use. Optional.
     * @returns {Uint8ClampedArray} The dst object filled with the color4b
     */
    static sampleColor4b (vec, drawable, dst, effectMask) {
        const localPosition = getLocalPosition(drawable, vec);
        if (localPosition[0] < 0 || localPosition[1] < 0 ||
            localPosition[0] > 1 || localPosition[1] > 1) {
            dst[0] = 0;
            dst[1] = 0;
            dst[2] = 0;
            dst[3] = 0;
            return dst;
        }

        if (!isTouchingClipMask(drawable, vec)) {
            dst[0] = 0;
            dst[1] = 0;
            dst[2] = 0;
            dst[3] = 0;
            return dst;
        }

        const textColor =
        // commenting out to only use nearest for now
        // drawable.skin.useNearest(drawable._scale, drawable) ?
             drawable.skin._silhouette.colorAtNearest(localPosition, dst);
        // : drawable.skin._silhouette.colorAtLinear(localPosition, dst);

        if (drawable.enabledEffects === 0) return textColor;
        return EffectTransform.transformColor(drawable, textColor, effectMask);
    }

    /**
     * Normalize effect padding metadata into [x, y] normalized expansion amounts.
     * @param {number|Array|object} paddingValue Raw padding metadata.
     * @param {?Skin} skin Skin used to convert texel padding into normalized padding.
     * @returns {Array<number>} Padding on X and Y axes.
     * @private
     */
    static _normalizeEffectPadding (paddingValue, skin) {
        const normalizeTexels = (texelsX, texelsY) => {
            const skinSize = skin ? skin.size : [0, 0];
            const width = Math.max(1, Number(skinSize[0]) || 1);
            const height = Math.max(1, Number(skinSize[1]) || 1);
            return [
                Math.max(0, texelsX) / width,
                Math.max(0, texelsY) / height
            ];
        };

        if (typeof paddingValue === 'number') {
            const padding = Math.max(0, paddingValue);
            return [padding, padding];
        }

        if (Array.isArray(paddingValue)) {
            return [
                Math.max(0, Number(paddingValue[0]) || 0),
                Math.max(0, Number(paddingValue[1]) || 0)
            ];
        }

        if (paddingValue && typeof paddingValue === 'object') {
            if ('texels' in paddingValue) {
                const texels = Math.max(0, Number(paddingValue.texels) || 0);
                return normalizeTexels(texels, texels);
            }

            if ('texelsX' in paddingValue || 'texelsY' in paddingValue) {
                return normalizeTexels(
                    Number(paddingValue.texelsX) || 0,
                    Number(paddingValue.texelsY) || 0
                );
            }

            return [
                Math.max(0, Number(paddingValue.x) || 0),
                Math.max(0, Number(paddingValue.y) || 0)
            ];
        }

        return [0, 0];
    }
}

module.exports = Drawable;
