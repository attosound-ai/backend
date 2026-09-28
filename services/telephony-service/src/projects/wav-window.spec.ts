import {
  leerCabeceraWav,
  rangoDeBytes,
  bytesPorFotograma,
  picosDeMuestras,
  lectorDeFotogramas,
  tamanoDeContentRange,
} from "./wav-window";

/** Un WAV de verdad, con los bloques en su sitio y opcionalmente un LIST. */
function wav(opciones: {
  frames: number;
  channels?: number;
  bits?: number;
  rate?: number;
  conList?: boolean;
  formato?: number;
}): Buffer {
  const channels = opciones.channels ?? 1;
  const bits = opciones.bits ?? 16;
  const rate = opciones.rate ?? 48000;
  const bpf = (bits / 8) * channels;
  const dataBytes = opciones.frames * bpf;
  const list = opciones.conList
    ? (() => {
        const b = Buffer.alloc(8 + 20);
        b.write("LIST", 0, "ascii");
        b.writeUInt32LE(20, 4);
        b.write("INFOISFT", 8, "ascii");
        return b;
      })()
    : Buffer.alloc(0);

  const fmt = Buffer.alloc(8 + 16);
  fmt.write("fmt ", 0, "ascii");
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(opciones.formato ?? 1, 8);
  fmt.writeUInt16LE(channels, 10);
  fmt.writeUInt32LE(rate, 12);
  fmt.writeUInt32LE(rate * bpf, 16);
  fmt.writeUInt16LE(bpf, 20);
  fmt.writeUInt16LE(bits, 22);

  const dataHead = Buffer.alloc(8);
  dataHead.write("data", 0, "ascii");
  dataHead.writeUInt32LE(dataBytes, 4);

  const riff = Buffer.alloc(12);
  riff.write("RIFF", 0, "ascii");
  riff.writeUInt32LE(4 + fmt.length + list.length + dataHead.length + dataBytes, 4);
  riff.write("WAVE", 8, "ascii");

  return Buffer.concat([riff, fmt, list, dataHead, Buffer.alloc(dataBytes)]);
}

describe("leerCabeceraWav", () => {
  it("encuentra el bloque data de un WAV normal", () => {
    const cab = leerCabeceraWav(wav({ frames: 1000 }));
    expect(cab).not.toBeNull();
    expect(cab!.dataOffset).toBe(44);
    expect(cab!.dataBytes).toBe(2000);
    expect(cab!.channels).toBe(1);
    expect(cab!.bitsPerSample).toBe(16);
    expect(cab!.sampleRate).toBe(48000);
  });

  it("no se cree los 44 bytes fijos cuando hay un LIST por medio", () => {
    // Esto es lo que mete ffmpeg con los metadatos. Con el offset fijo de 44
    // los primeros 28 bytes de "audio" eran en realidad cabecera.
    const cab = leerCabeceraWav(wav({ frames: 1000, conList: true }));
    expect(cab!.dataOffset).toBe(44 + 28);
  });

  it("rechaza lo que no sabe leer y deja que el que llama se lo baja entero", () => {
    expect(leerCabeceraWav(Buffer.from("no soy un wav"))).toBeNull();
    // Formato 3 es float de 32 bits: leerlo como enteros daría una onda falsa.
    expect(leerCabeceraWav(wav({ frames: 100, formato: 3 }))).toBeNull();
    expect(leerCabeceraWav(Buffer.alloc(4))).toBeNull();
  });
});

describe("rangoDeBytes", () => {
  const cab = leerCabeceraWav(wav({ frames: 48000 }))!;
  const total = 44 + 96000;

  it("el archivo entero es todo el bloque data", () => {
    const r = rangoDeBytes(cab, total, 0, 1)!;
    expect(r.start).toBe(44);
    expect(r.end).toBe(total - 1);
    expect(r.frames).toBe(48000);
  });

  it("una ventana pide solo sus bytes", () => {
    // Dos décimas de segundo en el medio de un segundo de audio.
    const r = rangoDeBytes(cab, total, 0.4, 0.6)!;
    expect(r.frames).toBe(9600);
    expect(r.end - r.start + 1).toBe(19200);
  });

  it("siempre cuadra a fotograma entero, o la onda saldría cruzada", () => {
    const esteReo = leerCabeceraWav(wav({ frames: 1000, channels: 2 }))!;
    const bpf = bytesPorFotograma(esteReo);
    expect(bpf).toBe(4);
    const r = rangoDeBytes(esteReo, 44 + 4000, 0.3333, 0.6667)!;
    expect((r.start - esteReo.dataOffset) % bpf).toBe(0);
    expect((r.end + 1 - esteReo.dataOffset) % bpf).toBe(0);
  });

  it("nunca devuelve una ventana vacía", () => {
    const r = rangoDeBytes(cab, total, 0.5, 0.5)!;
    expect(r.frames).toBeGreaterThan(0);
  });
});

describe("picosDeMuestras", () => {
  it("no devuelve más cubos que muestras hay", () => {
    // Este era el fallo de ampliar mucho: 2000 cubos sobre 500 muestras daban
    // cubos de tamaño cero y la onda salía plana del todo.
    const picos = picosDeMuestras(() => 16384, 500, 2000, 32768);
    expect(picos).toHaveLength(500);
    expect(picos[0]).toBeCloseTo(0.5, 3);
  });

  it("se queda con el pico del cubo, no con la media", () => {
    // Un solo golpe en medio de silencio tiene que sobrevivir.
    const leer = (i: number) => (i === 7 ? 32768 : 0);
    const picos = picosDeMuestras(leer, 100, 10, 32768);
    expect(picos[0]).toBe(1);
    expect(picos[1]).toBe(0);
  });

  it("reparte las muestras sin dejarse la última", () => {
    const picos = picosDeMuestras((i) => i, 1000, 100, 1000);
    expect(picos).toHaveLength(100);
    expect(picos[99]).toBeCloseTo(0.999, 3);
  });

  it("sin muestras no hay onda", () => {
    expect(picosDeMuestras(() => 1, 0, 10, 32768)).toEqual([]);
  });
});

describe("lectorDeFotogramas", () => {
  const cab16 = leerCabeceraWav(wav({ frames: 4 }))!;

  it("lee enteros de 16 bits con signo", () => {
    const buf = Buffer.alloc(8);
    buf.writeInt16LE(32767, 0);
    buf.writeInt16LE(-32768, 2);
    buf.writeInt16LE(0, 4);
    buf.writeInt16LE(-16384, 6);
    const l = lectorDeFotogramas(buf, cab16);
    expect(l.frames).toBe(4);
    expect(l.leer(0)).toBe(32767);
    // El negativo más grande se lee en valor absoluto, no desbordado.
    expect(l.leer(1)).toBe(32768);
    expect(l.leer(2)).toBe(0);
    expect(l.leer(3)).toBe(16384);
  });

  it("se queda con el canal que más suena, no con el primero", () => {
    const cab = leerCabeceraWav(wav({ frames: 2, channels: 2 }))!;
    const buf = Buffer.alloc(8);
    buf.writeInt16LE(0, 0); // izquierdo en silencio
    buf.writeInt16LE(20000, 2); // derecho con un golpe
    buf.writeInt16LE(100, 4);
    buf.writeInt16LE(50, 6);
    const l = lectorDeFotogramas(buf, cab);
    expect(l.frames).toBe(2);
    expect(l.leer(0)).toBe(20000);
    expect(l.leer(1)).toBe(100);
  });

  it("los ocho bits van sin signo, con el silencio en 128", () => {
    const cab = leerCabeceraWav(wav({ frames: 3, bits: 8 }))!;
    const buf = Buffer.from([128, 255, 0]);
    const l = lectorDeFotogramas(buf, cab);
    expect(l.maximo).toBe(128);
    expect(l.leer(0)).toBe(0);
    expect(l.leer(1)).toBe(127);
    expect(l.leer(2)).toBe(128);
  });

  it("veinticuatro bits, que es lo que trae un master", () => {
    const cab = leerCabeceraWav(wav({ frames: 2, bits: 24 }))!;
    const buf = Buffer.from([0x00, 0x00, 0x40, 0x00, 0x00, 0xc0]);
    const l = lectorDeFotogramas(buf, cab);
    expect(l.maximo).toBe(2 ** 23);
    expect(l.leer(0)).toBe(0x400000);
    expect(l.leer(1)).toBe(0x400000);
  });
});

describe("tamanoDeContentRange", () => {
  it("saca el tamaño del objeto", () => {
    expect(tamanoDeContentRange("bytes 0-8191/1234567")).toBe(1234567);
  });
  it("y aguanta lo que no lo trae", () => {
    expect(tamanoDeContentRange(undefined)).toBeNull();
    expect(tamanoDeContentRange("bytes 0-8191/*")).toBeNull();
    expect(tamanoDeContentRange("sin barra")).toBeNull();
  });
});
