# -*- coding: utf-8 -*-
"""
宁夏2025高考数据处理与阶跃知识库上传脚本
"""
import requests
import json
import time
import sys

# ============ 配置区 ============
API_KEY = "yKK8o3cy3FYEZM4gESAI3pWLFelhvNwPaU8Hx7Jvb24zRlfhKk36l7E6la56xpyj"
BASE_URL = "https://api.stepfun.com/v1"
OUTPUT_DIR = r"d:\mxklightinsky\getothetop\getothetop-main\getothetop-main"

HEADERS = {
    "Authorization": f"Bearer {API_KEY}",
    "User-Agent": "Mozilla/5.0"
}


def step1_convert_excel():
    """将一分一段表 Excel 转换为结构化文本文件"""
    print("\n=== 步骤1：转换一分一段表 Excel ===")
    import openpyxl

    wb = openpyxl.load_workbook(
        r"d:\mxklightinsky\getothetop\getothetop-main\getothetop-main\2025宁夏一分一段表.xlsx",
        data_only=True
    )
    ws = wb.active

    # 行1 = 大标题（普通历史|普通物理|体育历史|体育物理）
    # 行2 = 子标题（分数段|累计人数 重复4组）
    # 行3起 = 数据

    out_lines = []
    out_lines.append("宁夏2025年新高考一分一段表")
    out_lines.append("格式说明：每列两子列 = 分数段（如\"616分以上\"）+ 累计人数（即位次）")
    out_lines.append("选科对应：普通历史=历史类，普通物理=物理类，体育历史=体育历史类，体育物理=体育物理类")
    out_lines.append("")

    all_rows = list(ws.iter_rows(values_only=True))

    # 提取4组数据（每组2列：分数段 + 累计人数）
    # 顺序：普通历史(A,B) | 普通物理(C,D) | 体育历史(E,F) | 体育物理(G,H)
    # 跳过前2行（标题），取行3起
    data_rows = all_rows[2:]  # 跳过前2行

    col_labels = ["普通历史", "普通物理", "体育历史", "体育物理"]

    # 合并所有分数段，打印表头
    for label in col_labels:
        out_lines.append(f"--- {label} ---")

    for row in data_rows:
        # 取前8列有效数据
        a, b, c, d, e, f, g, h = row[0], row[1], row[2], row[3], row[4], row[5], row[6], row[7]
        # 过滤全空行
        if not any([a, b, c, d, e, f, g, h]):
            continue

        line_parts = []
        if a and b:
            line_parts.append(f"普通历史: {a}分, 位次{b}")
        if c and d:
            line_parts.append(f"普通物理: {c}分, 位次{d}")
        if e and f:
            line_parts.append(f"体育历史: {e}分, 位次{f}")
        if g and h:
            line_parts.append(f"体育物理: {g}分, 位次{h}")

        if line_parts:
            out_lines.append(" | ".join(line_parts))

    output_path = f"{OUTPUT_DIR}\\知识库_一分一段表.txt"
    with open(output_path, "w", encoding="utf-8") as f:
        f.write("\n".join(out_lines))

    print(f"已生成：{output_path}")
    print(f"共 {len(out_lines)} 行")

    # 同时生成 CSV 格式（更利于结构化检索）
    csv_lines = ["类别,分数段,累计人数(位次)"]
    for row in data_rows:
        a, b, c, d, e, f, g, h = row[0], row[1], row[2], row[3], row[4], row[5], row[6], row[7]
        if not any([a, b, c, d, e, f, g, h]):
            continue
        if a and b:
            csv_lines.append(f"普通历史,{a},{b}")
        if c and d:
            csv_lines.append(f"普通物理,{c},{d}")
        if e and f:
            csv_lines.append(f"体育历史,{e},{f}")
        if g and h:
            csv_lines.append(f"体育物理,{g},{h}")

    csv_path = f"{OUTPUT_DIR}\\知识库_一分一段表.csv"
    with open(csv_path, "w", encoding="utf-8") as f:
        f.write("\n".join(csv_lines))
    print(f"已生成：{csv_path}")

    return csv_path, output_path


def step2_upload_file(filepath, purpose="retrieval"):
    """上传文件到阶跃"""
    print(f"\n=== 步骤2：上传文件 {filepath} ===")
    filename = filepath.split("\\")[-1]

    with open(filepath, "rb") as f:
        files = {"file": (filename, f, "text/plain")}
        data = {"purpose": purpose}
        r = requests.post(
            f"{BASE_URL}/files",
            headers={"Authorization": f"Bearer {API_KEY}"},
            files=files,
            data=data,
            timeout=120
        )

    print(f"HTTP {r.status_code}: {r.text[:300]}")
    if r.status_code == 200:
        result = r.json()
        file_id = result.get("id")
        print(f"文件上传成功，file_id = {file_id}")
        return file_id
    else:
        print(f"上传失败：{r.text}")
        return None


def step3_wait_file_ready(file_id):
    """等待文件处理完成"""
    print(f"\n=== 等待文件 {file_id} 处理完成 ===")
    for i in range(30):
        r = requests.get(
            f"{BASE_URL}/files/{file_id}",
            headers={"Authorization": f"Bearer {API_KEY}"}
        )
        if r.status_code == 200:
            data = r.json()
            status = data.get("status", "unknown")
            print(f"  [{i+1}/30] status = {status}")
            if status == "success":
                print("文件已就绪！")
                return True
        time.sleep(5)
    print("等待超时，但继续尝试...")
    return False


def step4_create_vector_store(name):
    """创建知识库"""
    print(f"\n=== 步骤4：创建知识库 '{name}' ===")
    r = requests.post(
        f"{BASE_URL}/vector_stores",
        headers={"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"},
        json={"name": name}
    )
    print(f"HTTP {r.status_code}: {r.text[:300]}")
    if r.status_code == 200:
        result = r.json()
        vs_id = result.get("id")
        print(f"知识库创建成功，vector_store_id = {vs_id}")
        return vs_id
    else:
        print(f"创建失败：{r.text}")
        return None


def step5_add_files_to_store(vs_id, file_ids):
    """将文件关联到知识库"""
    print(f"\n=== 步骤5：关联文件到知识库 {vs_id} ===")
    file_ids_str = ",".join(file_ids) if isinstance(file_ids, list) else file_ids
    payload = f"--data ;\r\nfile_ids={file_ids_str}\r\n"
    # 使用 requests_toolbelt 或直接构造 multipart

    from requests_toolbelt.multipart.encoder import MultipartEncoder
    m = MultipartEncoder(fields={"file_ids": file_ids_str})
    r = requests.post(
        f"{BASE_URL}/vector_stores/{vs_id}/files",
        headers={"Authorization": f"Bearer {API_KEY}", "Content-Type": m.content_type},
        data=m,
        timeout=120
    )
    print(f"HTTP {r.status_code}: {r.text[:300]}")
    if r.status_code == 200:
        print("文件关联成功！")
        return True
    else:
        print(f"关联失败：{r.text}")
        return False


def main():
    print("=" * 50)
    print("宁夏2025高考数据 → 阶跃知识库上传")
    print("=" * 50)

    # 步骤1：转换一分一段表
    csv_path, txt_path = step1_convert_excel()

    # 投档线文件直接使用 txt
    toufang_path = f"{OUTPUT_DIR}\\2025年宁夏回族自治区投档线.txt"

    # 步骤2：上传文件
    print("\n\n>>> 上传投档线数据 >>>")
    fid1 = step2_upload_file(toufang_path)
    print("\n\n>>> 上传一分一段表 CSV >>>")
    fid2 = step2_upload_file(csv_path)
    print("\n\n>>> 上传一分一段表 TXT（备用）>>>")
    fid3 = step2_upload_file(txt_path)

    file_ids = [fid for fid in [fid1, fid2, fid3] if fid]
    print(f"\n已上传文件IDs：{file_ids}")

    if not file_ids:
        print("没有文件上传成功，退出")
        sys.exit(1)

    # 等待文件处理完成
    for fid in file_ids:
        step3_wait_file_ready(fid)

    # 步骤4：创建知识库
    vs_id = step4_create_vector_store("宁夏2025高考数据")

    if vs_id:
        # 步骤5：关联文件
        step5_add_files_to_store(vs_id, file_ids)

        print("\n" + "=" * 50)
        print("✅ 完成！知识库 ID 如下：")
        print(f"   {vs_id}")
        print("=" * 50)
        print("\n下一步：将上述 ID 填入 ECS 环境变量：")
        print(f'   export STEPFUN_VECTOR_STORE_ID="{vs_id}"')
    else:
        print("\n❌ 知识库创建失败，请检查 API Key 权限或配额")


if __name__ == "__main__":
    main()
