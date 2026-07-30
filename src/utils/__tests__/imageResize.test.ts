import { computeResizeTarget } from '../imageResize';

describe('imageResize — computeResizeTarget (pure, no native module)', () => {
  test('an already-small landscape photo needs no resize', () => {
    expect(computeResizeTarget(800, 600)).toBeUndefined();
  });

  test('an already-small portrait photo needs no resize', () => {
    expect(computeResizeTarget(600, 800)).toBeUndefined();
  });

  test('a photo exactly at the cap needs no resize', () => {
    expect(computeResizeTarget(1024, 768, 1024)).toBeUndefined();
  });

  test('a large landscape photo is capped by width, the true long edge', () => {
    expect(computeResizeTarget(4000, 3000, 1024)).toEqual({ width: 1024 });
  });

  test('a large portrait photo is capped by height, the true long edge — capping width alone would do nothing', () => {
    expect(computeResizeTarget(3000, 4000, 1024)).toEqual({ height: 1024 });
  });

  test('a large square photo is capped by width (either edge is equally the long edge)', () => {
    expect(computeResizeTarget(3000, 3000, 1024)).toEqual({ width: 1024 });
  });

  test('never upscales a smaller image up to the cap', () => {
    expect(computeResizeTarget(200, 150, 1024)).toBeUndefined();
  });

  test('a custom max dimension is respected', () => {
    expect(computeResizeTarget(2000, 1500, 500)).toEqual({ width: 500 });
    expect(computeResizeTarget(2000, 1500, 3000)).toBeUndefined();
  });
});
