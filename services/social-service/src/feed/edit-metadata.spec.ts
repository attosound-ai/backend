import {
  EDIT_METADATA_MAX_KEYS,
  EDIT_METADATA_MAX_VALUE,
  editMetadataFrom,
} from './edit-metadata';

describe('editMetadataFrom', () => {
  it('lets the cover and the tags through, empty values included (they remove)', () => {
    expect(
      editMetadataFrom({
        coverPublicId: 'atto/content/square_abc',
        taggedUserIds: '',
        taggedUsernames: '',
      }),
    ).toEqual({
      coverPublicId: 'atto/content/square_abc',
      taggedUserIds: '',
      taggedUsernames: '',
    });
  });

  it('is undefined when there is nothing usable, so the post metadata is not touched', () => {
    expect(editMetadataFrom(undefined)).toBeUndefined();
    expect(editMetadataFrom(null)).toBeUndefined();
    expect(editMetadataFrom('x')).toBeUndefined();
    expect(editMetadataFrom(['a'])).toBeUndefined();
    expect(editMetadataFrom({})).toBeUndefined();
    expect(editMetadataFrom({ a: 1, b: { c: 'd' } })).toBeUndefined();
  });

  it('drops values that are not strings and oversized keys or values', () => {
    expect(
      editMetadataFrom({
        ok: 'yes',
        n: 3,
        ['k'.repeat(65)]: 'long key',
        big: 'v'.repeat(EDIT_METADATA_MAX_VALUE + 1),
      }),
    ).toEqual({ ok: 'yes' });
  });

  it('keeps at most the key limit', () => {
    const raw: Record<string, string> = {};
    for (let i = 0; i < EDIT_METADATA_MAX_KEYS + 5; i++) raw[`k${i}`] = 'v';
    expect(Object.keys(editMetadataFrom(raw) ?? {})).toHaveLength(EDIT_METADATA_MAX_KEYS);
  });
});
