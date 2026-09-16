/**
 * 图片压缩（成绩附件用）
 *
 * 为什么要有这个模块：成绩录入和成绩修改都要挂附件，两边各写一份压缩逻辑的话，
 * 迟早会出现「录入限制 3 张、修改限制 5 张」这种不一致。
 *
 * 取用的压缩策略：
 *   先按最长边缩到 1600px，再按 0.75 质量转 JPEG —— 手机拍的作业照片
 *   通常能从 3~5MB 压到 200KB 上下，考试卷面细节仍然看得清。
 *   压完还超 1MB 的直接拒收并说明原因，不做二次降质
 *   （二次降质会让卷面数字糊掉，教师回头看不清分数，反而更糟）。
 *
 * `collectImages` 的第三个参数是压缩器的注入点 —— 默认用真实实现，
 * 测试里换成假实现就能在不碰 DOM 的情况下验证张数上限、类型过滤与错误话术。
 */

export const MAX_IMAGES = 3
export const MAX_DATA_URL_LENGTH = 1024 * 1024 // 压缩后 dataURL 的字符数上限（≈1MB）
export const MAX_WIDTH = 1600
export const COMPRESS_QUALITY = 0.75

/** 把一张图片文件压成 dataURL。需要在浏览器环境（FileReader / Image / canvas）下运行。 */
export function compressImage(file, { maxWidth = MAX_WIDTH, quality = COMPRESS_QUALITY } = {}) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('读取失败'))
    reader.onload = ev => {
      const img = new Image()
      img.onerror = () => reject(new Error('解码失败'))
      img.onload = () => {
        let { width, height } = img
        if (width > maxWidth) {
          height = Math.round(height * (maxWidth / width))
          width = maxWidth
        }
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        canvas.getContext('2d').drawImage(img, 0, 0, width, height)
        try {
          resolve(canvas.toDataURL('image/jpeg', quality))
        } catch (e) {
          reject(e)
        }
      }
      img.src = ev.target.result
    }
    reader.readAsDataURL(file)
  })
}

/**
 * 处理一批用户选中的文件，返回可直接挂到表单上的附件数组。
 *
 * @param fileList    input[type=file] 的 files
 * @param remaining   还能再加几张（总数上限 MAX_IMAGES 由调用方算好传进来）
 * @param compress    压缩器（测试注入点）
 * @returns {{ added: {src,name}[], errors: string[] }}
 *          逐条收集错误而不是遇到第一个就中断 —— 教师一次选 5 张，其中 1 张格式不对时，
 *          应该把好的 3 张收下、只报那 1 张的问题，而不是整批放弃。
 */
export async function collectImages(fileList, remaining, compress = compressImage) {
  const files = Array.from(fileList || [])
  const added = []
  const errors = []
  const room = Math.max(0, Math.min(MAX_IMAGES, Number(remaining) || 0))

  for (const file of files) {
    if (added.length >= room) {
      errors.push(`最多 ${MAX_IMAGES} 张，超出的已忽略`)
      break
    }
    if (!file.type || !file.type.startsWith('image/')) {
      errors.push(`「${file.name}」不是图片，已跳过`)
      continue
    }
    try {
      const src = await compress(file)
      if (src.length > MAX_DATA_URL_LENGTH) {
        errors.push(`「${file.name}」压缩后仍超过 1MB，请选更小的图`)
        continue
      }
      added.push({ src, name: `${file.name} (${Math.round(src.length / 1024)}KB)` })
    } catch (e) {
      errors.push(`「${file.name}」处理失败：${e.message}`)
    }
  }
  return { added, errors }
}
