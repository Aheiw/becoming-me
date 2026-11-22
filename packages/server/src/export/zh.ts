export const ZH_LAYER_NAMES: Record<string, string> = {
  L1: '价值观与信念', L2: '自我看法与性格', L3: '人生经历', L4: '职业经历与能力',
  L5: '人际关系', L6: '观点与立场', L7: '恐惧与回避', L8: '决策与行为习惯',
  L9: '目标与方向', L10: '偏好与做事方式',
}

export const ZH_ZONES: Record<string, string> = { CORE: '核心', SHAPE: '经历与模式', STATE: '当前状态' }

const headings: Record<string, Record<string, string>> = {
  values: { core_values: '不可妥协的价值观', consistent_values: '一直重视的事', anti_values: '不能接受的事', admired_people: '体现我价值观的人', worldview: '信念与世界观', priorities: '做选择时的优先顺序' },
  character: { temperament: '性格与气质', natural_actions: '习惯主动做的事', motivation_types: '动力来源', thinking_patterns: '思考习惯', energizing: '让我有精神的情境', draining: '让我消耗的情境', body_signals: '身体信号', communication: '沟通特点' },
  relationships: { key_people: '重要的人', compatible: '和我合得来的人', incompatible: '和我合不来的人', influential: '持续影响我的人', community: '社群与归属感' },
  opinions: { overrated: '我认为被高估的事', underrated: '我认为被低估的事', work_style: '工作与做事方式', society: '社会与商业', frustrations: '让我不满或不舒服的事' },
  fears: { fears: '害怕的事', avoidances: '回避过的事', feared_self: '不想成为的样子', fear_roots: '恐惧的来源' },
  patterns: { positive: '反复出现的优势', negative: '反复遇到的问题', handling: '我目前的应对方式' },
  goals: { main_goals: '现阶段的主要目标', direction: '接下来的方向', leaving: '想放下的事', issues: '眼下的困惑与未解决的问题', focus: '近期重点' },
  preferences: { ai_style: '与 AI 的沟通偏好', work_style: '做事方式', likes: '喜欢的事', dislikes: '不喜欢或不擅长的事' },
}

export function zhSectionHeading(category: string, subcategory: string): string {
  return headings[category]?.[subcategory] ?? '其他'
}
