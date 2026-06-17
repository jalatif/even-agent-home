const SAMPLE_RATE = 16000
const CHANNELS = 1
const BITS_PER_SAMPLE = 16

export function pcmChunksToWav(chunks: Uint8Array[]): Blob {
  const pcmLength = chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
  const buffer = new ArrayBuffer(44 + pcmLength)
  const view = new DataView(buffer)

  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, 36 + pcmLength, true)
  writeAscii(view, 8, 'WAVE')
  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, CHANNELS, true)
  view.setUint32(24, SAMPLE_RATE, true)
  view.setUint32(28, (SAMPLE_RATE * CHANNELS * BITS_PER_SAMPLE) / 8, true)
  view.setUint16(32, (CHANNELS * BITS_PER_SAMPLE) / 8, true)
  view.setUint16(34, BITS_PER_SAMPLE, true)
  writeAscii(view, 36, 'data')
  view.setUint32(40, pcmLength, true)

  const output = new Uint8Array(buffer, 44)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }

  return new Blob([buffer], { type: 'audio/wav' })
}

function writeAscii(view: DataView, offset: number, value: string) {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index))
  }
}
