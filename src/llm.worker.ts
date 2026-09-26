import { pipeline } from '@huggingface/transformers'

const MODEL = 'Mike0021/MiniCPM5-2B-ONNX'
const MODEL_REVISION = '04a6c49fcba3a65a0351c92644c3a7e9d4343059'

type Generator = Awaited<ReturnType<typeof pipeline<'text-generation'>>>
type Request =
  | { type: 'load'; requestId: number }
  | { type: 'generate'; requestId: number; messages: Array<{ role: 'system' | 'user'; content: string }> }

let generator: Generator | null = null
let loading: Promise<Generator> | null = null

function loadModel(requestId: number): Promise<Generator> {
  if (generator) return Promise.resolve(generator)
  if (!loading) {
    loading = pipeline('text-generation', MODEL, {
      device: 'webgpu',
      dtype: 'q4f16',
      revision: MODEL_REVISION,
      progress_callback(info) {
        if (info.status === 'progress_total') {
          self.postMessage({
            type: 'progress',
            requestId,
            percent: info.progress,
            loaded: info.loaded,
            total: info.total,
          })
        }
      },
    }).then((loaded) => {
      generator = loaded
      return loaded
    }).finally(() => {
      loading = null
    })
  }
  return loading
}

self.onmessage = async (event: MessageEvent<Request>) => {
  const request = event.data
  try {
    const model = await loadModel(request.requestId)
    if (request.type === 'load') {
      self.postMessage({ type: 'ready', requestId: request.requestId })
      return
    }

    const output = await model(request.messages, {
      max_new_tokens: 256,
      do_sample: false,
      return_full_text: false,
      tokenizer_encode_kwargs: { enable_thinking: false },
    })
    const generated = (output as unknown as Array<{
      generated_text: string | Array<{ content?: string }>
    }>)[0]?.generated_text
    const answer = typeof generated === 'string'
      ? generated
      : generated?.at(-1)?.content
    if (typeof answer !== 'string') {
      throw new Error('The model returned no text.')
    }
    self.postMessage({ type: 'answer', requestId: request.requestId, answer })
  } catch (error) {
    self.postMessage({
      type: 'error',
      requestId: request.requestId,
      message: error instanceof Error ? error.message : String(error),
    })
  }
}
