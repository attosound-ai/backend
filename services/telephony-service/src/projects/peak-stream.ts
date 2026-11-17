import { picosDeMuestras } from "./wav-window";

/**
 * La envolvente de un audio que llega decodificado por trozos (la salida de
 * ffmpeg en PCM de 16 bits intercalado), sin guardarlo entero en memoria.
 *
 * Hace falta para los segmentos en m4a: no se pueden leer por rango de bytes
 * como un WAV, así que se decodifican, y 30 minutos a 48 kHz estéreo son
 * 345 MB de PCM. Aquí se guardan solo minipicos: el pico de cada bloque de
 * `bloque` fotogramas, con ocho bloques por cubo pedido como mínimo. Al
 * terminar, los minipicos se agrupan en los cubos pedidos con el mismo
 * picosDeMuestras de los WAV, así que el resultado es el pico exacto de cada
 * cubo salvo en sus bordes (como mucho un octavo de cubo de corrimiento).
 *
 * Si los fotogramas reales salen distintos de los estimados (la duración de
 * ffprobe no es exacta al fotograma), no se pierde nada: los minipicos se
 * reparten sobre los que de verdad llegaron.
 */
export class PicosEnFlujo {
  private readonly canales: number;
  private readonly bloque: number;
  private readonly mini: number[] = [];
  private picoBloque = 0;
  private enBloque = 0;
  private resto: Buffer | null = null;
  private fotogramas = 0;

  constructor(
    framesEstimados: number,
    private readonly pedidos: number,
    canales: number,
  ) {
    this.canales = Math.max(1, Math.floor(canales) || 1);
    const objetivo = Math.max(1, Math.floor(pedidos)) * 8;
    this.bloque = Math.max(1, Math.floor(Math.max(0, framesEstimados) / objetivo));
  }

  /** Un trozo de PCM s16le intercalado; puede cortar a media muestra. */
  push(chunk: Buffer): void {
    let buf = chunk;
    if (this.resto && this.resto.length > 0) {
      buf = Buffer.concat([this.resto, chunk]);
      this.resto = null;
    }
    const bpf = 2 * this.canales;
    const enteros = Math.floor(buf.length / bpf);
    if (enteros > 0) {
      // Un Int16Array sobre los bytes, no readInt16LE por muestra: es unas
      // diez veces más rápido, y en un m4a de 10 minutos a 48 kHz estéreo
      // son 57 millones de muestras. Exige desplazamiento par: si el trozo
      // cae impar, se copia.
      const usable = enteros * bpf;
      const view =
        buf.byteOffset % 2 === 0
          ? new Int16Array(buf.buffer, buf.byteOffset, usable / 2)
          : new Int16Array(Uint8Array.prototype.slice.call(buf, 0, usable).buffer);
      const canales = this.canales;
      const bloque = this.bloque;
      let picoBloque = this.picoBloque;
      let enBloque = this.enBloque;
      let i = 0;
      for (let f = 0; f < enteros; f++) {
        let pico = 0;
        for (let c = 0; c < canales; c++) {
          let v = view[i++];
          if (v < 0) v = -v;
          if (v > pico) pico = v;
        }
        if (pico > picoBloque) picoBloque = pico;
        if (++enBloque >= bloque) {
          this.mini.push(picoBloque);
          picoBloque = 0;
          enBloque = 0;
        }
      }
      this.picoBloque = picoBloque;
      this.enBloque = enBloque;
    }
    this.fotogramas += enteros;
    const sobra = buf.length - enteros * bpf;
    if (sobra > 0) this.resto = Buffer.from(buf.subarray(buf.length - sobra));
  }

  /** Fotogramas completos recibidos hasta ahora. */
  get frames(): number {
    return this.fotogramas;
  }

  terminar(): number[] {
    if (this.enBloque > 0) {
      this.mini.push(this.picoBloque);
      this.picoBloque = 0;
      this.enBloque = 0;
    }
    const mini = this.mini;
    return picosDeMuestras((i) => mini[i], mini.length, this.pedidos, 32768);
  }
}
