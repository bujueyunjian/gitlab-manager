import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { ArrowRight, Search } from "lucide-react";
import { api, errorMessage } from "./api";
import { inputLines, resolvedSelection } from "./domain";
import type { Project } from "./types";
import { Badge, Button, Dialog, ErrorBox } from "./ui";
import { ReadProgressView } from "./ReadProgress";
import { useReadProgress } from "./useReadProgress";

/** Resolve user references with per-input progress before allowing an explicit selection. */
export function ResolveDialog({
  connectionId,
  onClose,
  onSelect,
}: {
  connectionId: string;
  onClose: () => void;
  onSelect: (projects: Project[]) => void;
}) {
  const [text, setText] = useState("");
  const [choices, setChoices] = useState<Record<number, number>>({});
  const progress = useReadProgress(connectionId);
  const search = useMutation({
    mutationFn: () =>
      progress.track(inputLines(text).length, (report) =>
        api.resolve(connectionId, inputLines(text), report),
      ),
    onSuccess: () => setChoices({}),
  });
  const selected = resolvedSelection(search.data ?? [], choices);
  // Any input edit invalidates prior matches, so old results cannot authorize new text.
  function changeText(value: string) {
    setText(value);
    search.reset();
    setChoices({});
  }
  return (
    <Dialog
      title="批量定位仓库"
      description="粘贴多个仓库地址、项目路径或应用名，每行一项。"
      onClose={onClose}
      busy={search.isPending}
      wide
      footer={
        <>
          <span className="foot-info">
            {search.data
              ? `${selected.length} 个唯一仓库已确认`
              : `${inputLines(text).length} 条输入`}
          </span>
          <Button onClick={onClose} disabled={search.isPending}>
            取消
          </Button>
          {!search.data ? (
            <Button
              variant="primary"
              busy={search.isPending}
              disabled={!inputLines(text).length}
              onClick={() => search.mutate()}
            >
              <Search size={15} />
              查找仓库
            </Button>
          ) : (
            <Button
              variant="primary"
              disabled={!selected.length}
              onClick={() => onSelect(selected)}
            >
              选择这些仓库
              <ArrowRight size={15} />
            </Button>
          )}
        </>
      }
    >
      <label className="form-field">
        <span>仓库地址或应用名</span>
        <textarea
          className="repository-input"
          disabled={search.isPending}
          value={text}
          onChange={(e) => changeText(e.target.value)}
          placeholder={
            "https://gitlab.example.com/platform/app.git\nplatform/another-app\napplication-name"
          }
          spellCheck={false}
          autoFocus
        />
      </label>
      {search.isPending && <ReadProgressView title="正在定位仓库" progress={progress.state} />}
      {search.error && <ErrorBox message={errorMessage(search.error)} />}
      {search.data && (
        <div className="table-scroll resolve-results">
          <table>
            <thead>
              <tr>
                <th>输入</th>
                <th>匹配结果</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {search.data.map((row, index) => (
                <tr key={row.input}>
                  <td className="wrap-cell">{row.input}</td>
                  <td>
                    {row.error ? (
                      <span className="error-text">{row.error}</span>
                    ) : row.candidates.length === 0 ? (
                      "没有匹配到可访问的仓库"
                    ) : row.candidates.length === 1 ? (
                      row.candidates[0].path_with_namespace
                    ) : (
                      <select
                        aria-label={`选择 ${row.input} 的匹配仓库`}
                        value={choices[index] ?? ""}
                        onChange={(e) =>
                          setChoices({ ...choices, [index]: Number(e.target.value) })
                        }
                      >
                        <option value="">同名项目，请明确选择</option>
                        {row.candidates.map((project) => (
                          <option value={project.id} key={project.id}>
                            {project.path_with_namespace}
                          </option>
                        ))}
                      </select>
                    )}
                  </td>
                  <td>
                    <Badge
                      color={
                        row.error
                          ? "red"
                          : row.candidates.length === 0
                            ? "gray"
                            : row.candidates.length > 1 && !choices[index]
                              ? "amber"
                              : "green"
                      }
                    >
                      {row.error
                        ? "查询失败"
                        : row.candidates.length === 0
                          ? "未找到"
                          : row.candidates.length > 1 && !choices[index]
                            ? "待选择"
                            : "已匹配"}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="hint">
        地址必须属于当前实例。相同项目只选择一次；同名或无法访问的项目不会被自动选中。
      </div>
    </Dialog>
  );
}
