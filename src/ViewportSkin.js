const twgl = require('twgl.js');

const Skin = require('./Skin');

class ViewportSkin extends Skin {
    /**
     * @param {int} id Unique skin id.
     * @param {RenderWebGL} renderer Renderer instance.
     */
    constructor (id, renderer) {
        super(id, renderer);

        /** @type {Array<number>} */
        this._size = [0, 0];

        /** @type {?Object} */
        this._framebuffer = null;
    }

    dispose () {
        const gl = this._renderer.gl;
        if (this._texture) {
            gl.deleteTexture(this._texture);
            this._texture = null;
        }
        if (this._framebuffer && this._framebuffer.framebuffer) {
            gl.deleteFramebuffer(this._framebuffer.framebuffer);
        }
        this._framebuffer = null;
        super.dispose();
    }

    /**
     * @returns {Array<number>} skin size in texels.
     */
    get size () {
        return [this._size[0], this._size[1]];
    }

    /**
     * @returns {?Object} twgl framebuffer info.
     */
    get framebuffer () {
        return this._framebuffer;
    }

    // eslint-disable-next-line no-unused-vars
    useNearest (scale, drawable) {
        return false;
    }

    // eslint-disable-next-line no-unused-vars
    getTexture (scale) {
        return this._texture || super.getTexture();
    }

    /**
     * Ensure viewport texture and framebuffer match target size.
     * @param {number} width texture width.
     * @param {number} height texture height.
     */
    setViewportSize (width, height) {
        const nextWidth = Math.max(1, Math.floor(width));
        const nextHeight = Math.max(1, Math.floor(height));
        if (this._size[0] === nextWidth && this._size[1] === nextHeight && this._texture && this._framebuffer) {
            return;
        }

        const gl = this._renderer.gl;

        if (this._texture) {
            gl.deleteTexture(this._texture);
            this._texture = null;
        }
        if (this._framebuffer && this._framebuffer.framebuffer) {
            gl.deleteFramebuffer(this._framebuffer.framebuffer);
            this._framebuffer = null;
        }

        this._size[0] = nextWidth;
        this._size[1] = nextHeight;
        this._rotationCenter[0] = nextWidth / 2;
        this._rotationCenter[1] = nextHeight / 2;

        this._texture = twgl.createTexture(gl, {
            mag: gl.LINEAR,
            min: gl.LINEAR,
            wrap: gl.CLAMP_TO_EDGE,
            width: nextWidth,
            height: nextHeight
        });

        this._framebuffer = twgl.createFramebufferInfo(gl, [{
            format: gl.RGBA,
            attachment: this._texture
        }], nextWidth, nextHeight);

        twgl.bindFramebufferInfo(gl, this._framebuffer);
        gl.viewport(0, 0, nextWidth, nextHeight);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        twgl.bindFramebufferInfo(gl, null);

        // ViewportSkin is GPU-only and does not provide CPU silhouette info.
        this.emitWasAltered();
    }
}

module.exports = ViewportSkin;
