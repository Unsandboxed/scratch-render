const twgl = require('twgl.js');

const Skin = require('./Skin');

class TileSkin extends Skin {
    /**
     * Create a tile-backed skin that composes multiple tile layers into one renderer texture.
     * @param {!int} id The ID for this Skin.
     * @param {!RenderWebGL} renderer The renderer which will use this skin.
     */
    constructor (id, renderer) {
        super(id, renderer);

        this._texture = null;
        this._textureSize = [1, 1];

        this._tileWidth = 32;
        this._tileHeight = 32;
        this._tilesWide = 1;
        this._tilesTall = 1;
        this._originX = 0;
        this._originY = 0;
        this._offsetX = 0;
        this._offsetY = 0;

        this._tileset = new Map();
        this._layers = new Map();
        this._overlay = {
            showGrid: false,
            gridOpacity: 0.28,
            hoverCell: null,
            previewCells: [],
            previewErase: false
        };

        this._canvas = null;
        this._context = null;
    }

    /**
     * Dispose of this object. Do not use it after calling this method.
     */
    dispose () {
        if (this._texture) {
            this._renderer.gl.deleteTexture(this._texture);
            this._texture = null;
        }
        this._canvas = null;
        this._context = null;
        super.dispose();
    }

    /**
     * @returns {Array<number>} the native size, in texels, of this skin.
     */
    get size () {
        return [this._textureSize[0], this._textureSize[1]];
    }

    /**
     * @param {Array<number>} scale scaling factors used for rendering.
     * @returns {WebGLTexture} The GL texture representation for this skin.
     */
    // eslint-disable-next-line no-unused-vars
    getTexture (scale) {
        return this._texture || super.getTexture();
    }

    _ensureCanvas () {
        if (this._canvas && this._context) {
            this._context.imageSmoothingEnabled = false;
            return true;
        }
        if (typeof document === 'undefined') {
            return false;
        }

        this._canvas = document.createElement('canvas');
        this._context = this._canvas.getContext('2d');
        if (this._context) {
            this._context.imageSmoothingEnabled = false;
        }
        return !!this._context;
    }

    _cellKey (x, y) {
        return `${Math.trunc(x)},${Math.trunc(y)}`;
    }

    _hashTileColor (tileId) {
        const text = String(tileId || '');
        let hash = 2166136261;
        for (let i = 0; i < text.length; i++) {
            hash ^= text.charCodeAt(i);
            hash = Math.imul(hash, 16777619);
        }
        const hue = Math.abs(hash) % 360;
        return `hsl(${hue} 66% 50%)`;
    }

    _drawFallbackTile (tileId, x, y, width, height) {
        this._context.fillStyle = this._hashTileColor(tileId);
        this._context.fillRect(x, y, width, height);
        this._context.fillStyle = 'rgba(255,255,255,0.92)';
        this._context.font = 'bold 10px Segoe UI';
        this._context.textBaseline = 'middle';
        this._context.fillText(String(tileId || '').slice(0, 8), x + 3, y + (height / 2), Math.max(0, width - 6));
    }

    _normalizeCells (cells) {
        const out = new Map();
        if (!cells) {
            return out;
        }

        const toValidTileId = value => {
            if (value === null || typeof value === 'undefined') {
                return '';
            }
            const normalized = String(value).trim();
            return normalized;
        };

        if (cells instanceof Map) {
            for (const [key, tileId] of cells) {
                const normalizedTileId = toValidTileId(tileId);
                if (normalizedTileId === '') continue;
                out.set(String(key), normalizedTileId);
            }
            return out;
        }

        if (Array.isArray(cells)) {
            for (const cell of cells) {
                if (!cell) continue;
                const x = Number.isFinite(cell.x) ? cell.x : cell.mapX;
                const y = Number.isFinite(cell.y) ? cell.y : cell.mapY;
                if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
                const normalizedTileId = toValidTileId(cell.tileId);
                if (normalizedTileId === '') continue;
                out.set(this._cellKey(x, y), normalizedTileId);
            }
            return out;
        }

        if (typeof cells === 'object') {
            for (const key of Object.keys(cells)) {
                const normalizedTileId = toValidTileId(cells[key]);
                if (normalizedTileId === '') continue;
                out.set(String(key), normalizedTileId);
            }
        }

        return out;
    }

    _normalizeTileCanvas (source) {
        if (!source) return null;
        if (typeof HTMLCanvasElement !== 'undefined' && source instanceof HTMLCanvasElement) {
            return source;
        }
        if (typeof document === 'undefined') {
            return null;
        }

        const width = Math.max(1, Math.round(source.width || source.naturalWidth || source.videoWidth || 0));
        const height = Math.max(1, Math.round(source.height || source.naturalHeight || source.videoHeight || 0));
        if (width <= 0 || height <= 0) return null;

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;
        ctx.imageSmoothingEnabled = false;

        if (typeof ImageData !== 'undefined' && source instanceof ImageData) {
            ctx.putImageData(source, 0, 0);
            return canvas;
        }

        ctx.drawImage(source, 0, 0, width, height);
        return canvas;
    }

    _setTextureFromCanvas (rotationCenter) {
        if (!this._ensureCanvas()) {
            return;
        }

        const gl = this._renderer.gl;
        if (this._texture === null) {
            this._texture = twgl.createTexture(gl, {
                auto: false,
                wrap: gl.CLAMP_TO_EDGE
            });
        }

        this._setTexture(this._canvas);
        this._textureSize[0] = this._canvas.width;
        this._textureSize[1] = this._canvas.height;

        const center = Array.isArray(rotationCenter) ? rotationCenter : this.calculateRotationCenter();
        this._rotationCenter[0] = center[0];
        this._rotationCenter[1] = center[1];
        this.emitWasAltered();
    }

    _renderLayers () {
        if (!this._ensureCanvas()) {
            return;
        }

        const pixelWidth = Math.max(1, Math.round(this._tilesWide * this._tileWidth));
        const pixelHeight = Math.max(1, Math.round(this._tilesTall * this._tileHeight));
        if (this._canvas.width !== pixelWidth || this._canvas.height !== pixelHeight) {
            this._canvas.width = pixelWidth;
            this._canvas.height = pixelHeight;
            this._context.imageSmoothingEnabled = false;
        }

        this._context.imageSmoothingEnabled = false;
        this._context.clearRect(0, 0, this._canvas.width, this._canvas.height);

        const layerNames = Array.from(this._layers.keys()).sort((a, b) =>
            String(a).localeCompare(String(b), undefined, {numeric: true, sensitivity: 'base'})
        );

        for (const layerName of layerNames) {
            const cells = this._layers.get(layerName);
            if (!cells) continue;

            for (const [key, tileId] of cells) {
                const comma = key.indexOf(',');
                if (comma === -1) continue;
                const x = Number(key.slice(0, comma));
                const y = Number(key.slice(comma + 1));
                if (!Number.isFinite(x) || !Number.isFinite(y)) continue;

                const tile = this._tileset.get(String(tileId));

                const localX = x - this._originX;
                const localY = y - this._originY;
                if (localX < -1 || localY < -1 || localX > this._tilesWide + 1 || localY > this._tilesTall + 1) {
                    continue;
                }

                const px = Math.round((localX * this._tileWidth) + this._offsetX);
                const py = Math.round(pixelHeight - ((localY + 1) * this._tileHeight) + this._offsetY);

                if (tile) {
                    this._context.drawImage(tile, px, py, this._tileWidth, this._tileHeight);
                } else {
                    this._drawFallbackTile(tileId, px, py, this._tileWidth, this._tileHeight);
                }
            }
        }

        this._renderOverlay(pixelWidth, pixelHeight);
    }

    _renderOverlay (pixelWidth, pixelHeight) {
        if (!this._overlay || this._overlay.showGrid !== true) {
            return;
        }

        const opacity = Math.max(0.08, Math.min(0.8, Number(this._overlay.gridOpacity) || 0.28));
        const majorStroke = `rgba(9, 12, 20, ${Math.min(0.75, opacity * 1.4)})`;
        const minorStroke = `rgba(255, 255, 255, ${Math.min(0.5, opacity)})`;
        const hoverStroke = 'rgba(56, 189, 248, 0.95)';
        const previewFill = this._overlay.previewErase ? 'rgba(239, 68, 68, 0.24)' : 'rgba(34, 197, 94, 0.22)';
        const previewStroke = this._overlay.previewErase ? 'rgba(239, 68, 68, 0.95)' : 'rgba(34, 197, 94, 0.95)';

        this._context.save();

        this._context.lineWidth = 1;
        this._context.strokeStyle = majorStroke;
        for (let x = 0; x <= this._tilesWide + 1; x++) {
            const screenX = Math.round((x * this._tileWidth) + this._offsetX) + 0.5;
            this._context.beginPath();
            this._context.moveTo(screenX, 0);
            this._context.lineTo(screenX, pixelHeight);
            this._context.stroke();
        }

        for (let y = 0; y <= this._tilesTall + 1; y++) {
            const screenY = Math.round(pixelHeight - (y * this._tileHeight) + this._offsetY) + 0.5;
            this._context.beginPath();
            this._context.moveTo(0, screenY);
            this._context.lineTo(pixelWidth, screenY);
            this._context.stroke();
        }

        this._context.lineWidth = 1;
        this._context.strokeStyle = minorStroke;
        for (let x = 0; x <= this._tilesWide + 1; x++) {
            const screenX = Math.round((x * this._tileWidth) + this._offsetX) - 0.5;
            this._context.beginPath();
            this._context.moveTo(screenX, 0);
            this._context.lineTo(screenX, pixelHeight);
            this._context.stroke();
        }

        for (let y = 0; y <= this._tilesTall + 1; y++) {
            const screenY = Math.round(pixelHeight - (y * this._tileHeight) + this._offsetY) - 0.5;
            this._context.beginPath();
            this._context.moveTo(0, screenY);
            this._context.lineTo(pixelWidth, screenY);
            this._context.stroke();
        }

        if (Array.isArray(this._overlay.previewCells) && this._overlay.previewCells.length > 0) {
            this._context.fillStyle = previewFill;
            this._context.strokeStyle = previewStroke;
            this._context.lineWidth = 2;
            for (const previewCell of this._overlay.previewCells) {
                if (!previewCell) continue;
                const localX = Number(previewCell.x) - this._originX;
                const localY = Number(previewCell.y) - this._originY;
                if (!Number.isFinite(localX) || !Number.isFinite(localY)) continue;
                const screenX = Math.round((localX * this._tileWidth) + this._offsetX);
                const screenY = Math.round(pixelHeight - ((localY + 1) * this._tileHeight) + this._offsetY);
                this._context.fillRect(screenX + 1, screenY + 1, Math.max(0, this._tileWidth - 2), Math.max(0, this._tileHeight - 2));
                this._context.strokeRect(screenX + 1, screenY + 1, Math.max(0, this._tileWidth - 2), Math.max(0, this._tileHeight - 2));
            }
        }

        if (this._overlay.hoverCell && Number.isFinite(this._overlay.hoverCell.x) && Number.isFinite(this._overlay.hoverCell.y)) {
            const localX = Number(this._overlay.hoverCell.x) - this._originX;
            const localY = Number(this._overlay.hoverCell.y) - this._originY;
            const screenX = Math.round((localX * this._tileWidth) + this._offsetX);
            const screenY = Math.round(pixelHeight - ((localY + 1) * this._tileHeight) + this._offsetY);
            this._context.strokeStyle = hoverStroke;
            this._context.lineWidth = 2;
            this._context.strokeRect(screenX + 1, screenY + 1, Math.max(0, this._tileWidth - 2), Math.max(0, this._tileHeight - 2));
        }

        this._context.restore();
    }

    /**
     * Replace full tile skin data.
      * @param {{tileWidth?: number, tileHeight?: number, tilesWide?: number, tilesTall?: number, originX?: number, originY?: number, offsetX?: number, offsetY?: number, tileset?: *, layers?: *, rotationCenter?: Array<number>}} data Full tile data payload.
     */
    setTilemapData (data = {}) {
        // Preserve subpixel tile dimensions so camera zoom does not quantize and shift the tile phase.
        if (Number.isFinite(data.tileWidth)) this._tileWidth = Math.max(0.01, Math.abs(data.tileWidth));
        if (Number.isFinite(data.tileHeight)) this._tileHeight = Math.max(0.01, Math.abs(data.tileHeight));
        if (Number.isFinite(data.tilesWide)) this._tilesWide = Math.max(1, Math.round(Math.abs(data.tilesWide)));
        if (Number.isFinite(data.tilesTall)) this._tilesTall = Math.max(1, Math.round(Math.abs(data.tilesTall)));
          if (Number.isFinite(data.originX)) this._originX = Math.trunc(data.originX);
          if (Number.isFinite(data.originY)) this._originY = Math.trunc(data.originY);
          if (Number.isFinite(data.offsetX)) this._offsetX = data.offsetX;
          if (Number.isFinite(data.offsetY)) this._offsetY = data.offsetY;
        if (data.overlay && typeof data.overlay === 'object') {
            this._overlay = {
                showGrid: data.overlay.showGrid === true,
                gridOpacity: Number.isFinite(data.overlay.gridOpacity) ? data.overlay.gridOpacity : this._overlay.gridOpacity,
                hoverCell: data.overlay.hoverCell || null,
                previewCells: Array.isArray(data.overlay.previewCells) ? data.overlay.previewCells : [],
                previewErase: data.overlay.previewErase === true
            };
        } else {
            this._overlay.showGrid = false;
            this._overlay.hoverCell = null;
            this._overlay.previewCells = [];
            this._overlay.previewErase = false;
        }

        if (Object.prototype.hasOwnProperty.call(data, 'tileset')) {
            this.setTileset(data.tileset, false);
        }

        if (Object.prototype.hasOwnProperty.call(data, 'layers')) {
            this._layers.clear();
            if (data.layers instanceof Map) {
                for (const [layerName, cells] of data.layers) {
                    this._layers.set(String(layerName), this._normalizeCells(cells));
                }
            } else if (Array.isArray(data.layers)) {
                for (const layer of data.layers) {
                    if (!layer) continue;
                    const name = String(layer.name || layer.layer || '0');
                    this._layers.set(name, this._normalizeCells(layer.cells));
                }
            } else if (typeof data.layers === 'object') {
                for (const layerName of Object.keys(data.layers)) {
                    this._layers.set(String(layerName), this._normalizeCells(data.layers[layerName]));
                }
            }
        }

        this._renderLayers();
        this._setTextureFromCanvas(data.rotationCenter);
    }

    /**
     * Replace the current tileset.
     * @param {*} tileset A mapping of tile IDs to image/canvas data.
     * @param {boolean} [rerender=true] Whether to rerender the composed texture.
     */
    setTileset (tileset, rerender = true) {
        this._tileset.clear();

        if (tileset instanceof Map) {
            for (const [tileId, source] of tileset) {
                const tileCanvas = this._normalizeTileCanvas(source);
                if (tileCanvas) {
                    this._tileset.set(String(tileId), tileCanvas);
                }
            }
        } else if (Array.isArray(tileset)) {
            for (const tile of tileset) {
                if (!tile) continue;
                const tileId = tile.id;
                const source = tile.canvas || tile.image || tile.bitmap;
                const tileCanvas = this._normalizeTileCanvas(source);
                if (tileCanvas && tileId !== null && typeof tileId !== 'undefined') {
                    this._tileset.set(String(tileId), tileCanvas);
                }
            }
        } else if (typeof tileset === 'object' && tileset !== null) {
            for (const tileId of Object.keys(tileset)) {
                const tileCanvas = this._normalizeTileCanvas(tileset[tileId]);
                if (tileCanvas) {
                    this._tileset.set(String(tileId), tileCanvas);
                }
            }
        }

        if (rerender) {
            this._renderLayers();
            this._setTextureFromCanvas();
        }
    }

    /**
     * Replace one layer.
     * @param {string|number} layerName Layer identifier.
     * @param {*} cells Layer cell data.
     */
    setLayer (layerName, cells) {
        this._layers.set(String(layerName), this._normalizeCells(cells));
        this._renderLayers();
        this._setTextureFromCanvas();
    }

    /**
     * Set one cell in one layer.
     * @param {string|number} layerName Layer identifier.
     * @param {number} x Cell x coordinate.
     * @param {number} y Cell y coordinate.
     * @param {string|number|null} tileId Tile identifier; clears when empty.
     */
    setCell (layerName, x, y, tileId) {
        const name = String(layerName);
        if (!this._layers.has(name)) {
            this._layers.set(name, new Map());
        }
        const layer = this._layers.get(name);
        const key = this._cellKey(x, y);

        if (tileId === null || typeof tileId === 'undefined' || tileId === '') {
            layer.delete(key);
        } else {
            layer.set(key, String(tileId));
        }

        this._renderLayers();
        this._setTextureFromCanvas();
    }

    /**
     * Clear all layer content while keeping dimensions and tileset.
     */
    clearLayers () {
        this._layers.clear();
        this._renderLayers();
        this._setTextureFromCanvas();
    }
}

module.exports = TileSkin;
