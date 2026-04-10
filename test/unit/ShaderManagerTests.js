const test = require('tap').test;

// Mock `window` and `document.createElement` for twgl.js.
global.window = {};
global.document = {
    createElement: () => ({getContext: () => {}})
};

const Drawable = require('../../src/Drawable');
const ShaderManager = require('../../src/ShaderManager');

const unregisterEffect = effectName => {
    delete ShaderManager.EFFECT_INFO[effectName];
    delete ShaderManager.CUSTOM_EFFECT_SHADER_HOOKS[effectName];
    ShaderManager.EFFECTS = Object.keys(ShaderManager.EFFECT_INFO);
};

test('registerEffect adds metadata and drawable uniforms', t => {
    const effectName = 'scanline_test';
    if (Object.prototype.hasOwnProperty.call(ShaderManager.EFFECT_INFO, effectName)) {
        unregisterEffect(effectName);
    }

    ShaderManager.registerEffect(effectName, {
        converter: x => x / 100,
        fragmentUniforms: 'uniform float u_scanline_test;',
        fragmentColor: 'gl_FragColor.rgb *= 1.0 - (u_scanline_test * 0.5);'
    });

    t.ok(Object.prototype.hasOwnProperty.call(ShaderManager.EFFECT_INFO, effectName));
    t.ok(ShaderManager.EFFECTS.includes(effectName));
    t.equal(ShaderManager.EFFECT_INFO[effectName].uniformName, 'u_scanline_test');

    const drawable = new Drawable(1, {dirty: false});
    t.equal(drawable.getUniforms().u_scanline_test, 0);

    unregisterEffect(effectName);
    t.end();
});

test('registerEffect rejects duplicate names', t => {
    const effectName = 'dupe_test';
    if (Object.prototype.hasOwnProperty.call(ShaderManager.EFFECT_INFO, effectName)) {
        unregisterEffect(effectName);
    }

    ShaderManager.registerEffect(effectName, {
        converter: x => x
    });

    t.throws(() => {
        ShaderManager.registerEffect(effectName, {
            converter: x => x
        });
    });

    unregisterEffect(effectName);
    t.end();
});
