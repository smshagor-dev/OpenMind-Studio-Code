//! `dependsOn`: the order tasks run in. Dependencies run first, each task once; a loop (`a` needs `b`, `b` needs
//! `a`) and a dependency that doesn't exist are refused before anything runs.

use crate::file::TaskDef;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum GraphError {
    #[error("Tasks depend on each other in a loop: {0}.")]
    Cycle(String),
    #[error("Task \"{task}\" depends on \"{missing}\", which doesn't exist.")]
    Missing { task: String, missing: String },
    #[error("The dependency chain is deeper than {0} tasks.")]
    TooDeep(usize),
}

const MAX_DEPTH: usize = 32;

/// A dependency is looked up in the task's own file first, then in the others.
fn find(tasks: &[TaskDef], label: &str, from: &TaskDef) -> Option<usize> {
    tasks
        .iter()
        .position(|t| t.label == label && t.source == from.source)
        .or_else(|| tasks.iter().position(|t| t.label == label))
}

fn visit(
    tasks: &[TaskDef],
    index: usize,
    stack: &mut Vec<usize>,
    order: &mut Vec<usize>,
) -> Result<(), GraphError> {
    if order.contains(&index) {
        return Ok(());
    }
    if let Some(start) = stack.iter().position(|&i| i == index) {
        let mut names: Vec<&str> = stack[start..]
            .iter()
            .map(|&i| tasks[i].label.as_str())
            .collect();
        names.push(tasks[index].label.as_str());
        return Err(GraphError::Cycle(names.join(" → ")));
    }
    if stack.len() >= MAX_DEPTH {
        return Err(GraphError::TooDeep(MAX_DEPTH));
    }
    stack.push(index);
    let task = &tasks[index];
    for label in &task.depends_on {
        let dependency = find(tasks, label, task).ok_or_else(|| GraphError::Missing {
            task: task.label.clone(),
            missing: label.clone(),
        })?;
        visit(tasks, dependency, stack, order)?;
    }
    stack.pop();
    order.push(index);
    Ok(())
}

/// The tasks to run for `tasks[start]`, dependencies first (indexes into `tasks`).
pub fn execution_order(tasks: &[TaskDef], start: usize) -> Result<Vec<usize>, GraphError> {
    let mut order = Vec::new();
    visit(tasks, start, &mut Vec::new(), &mut order)?;
    Ok(order)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::file::parse;

    fn tasks(text: &str) -> Vec<TaskDef> {
        parse("C:/w/.vscode/tasks.json", text).tasks
    }

    fn labels(all: &[TaskDef], order: &[usize]) -> Vec<String> {
        order.iter().map(|&i| all[i].label.clone()).collect()
    }

    #[test]
    fn dependencies_run_first_and_once() {
        let all = tasks(
            r#"{"tasks": [
            {"label": "a", "command": "a"},
            {"label": "b", "command": "b", "dependsOn": "a"},
            {"label": "c", "command": "c", "dependsOn": ["a", "b"]}
        ]}"#,
        );
        assert_eq!(
            labels(&all, &execution_order(&all, 2).unwrap()),
            ["a", "b", "c"]
        );
        assert_eq!(labels(&all, &execution_order(&all, 0).unwrap()), ["a"]);
    }

    #[test]
    fn loops_and_missing_tasks_are_refused() {
        let all = tasks(
            r#"{"tasks": [
            {"label": "a", "command": "a", "dependsOn": "b"},
            {"label": "b", "command": "b", "dependsOn": "c"},
            {"label": "c", "command": "c", "dependsOn": "a"},
            {"label": "d", "command": "d", "dependsOn": "gone"},
            {"label": "self", "command": "s", "dependsOn": "self"}
        ]}"#,
        );
        assert_eq!(
            execution_order(&all, 0).unwrap_err().to_string(),
            "Tasks depend on each other in a loop: a → b → c → a."
        );
        assert_eq!(
            execution_order(&all, 3).unwrap_err(),
            GraphError::Missing {
                task: "d".into(),
                missing: "gone".into()
            }
        );
        assert!(matches!(
            execution_order(&all, 4),
            Err(GraphError::Cycle(_))
        ));
    }

    #[test]
    fn a_dependency_in_the_same_file_wins() {
        let mut all = parse(
            "C:/w/.vscode/tasks.json",
            r#"{"tasks": [{"label": "prep", "command": "v"}]}"#,
        )
        .tasks;
        all.extend(
            parse(
                "C:/w/.openmind/tasks.json",
                r#"{"tasks": [{"label": "prep", "command": "o"}, {"label": "go", "command": "g", "dependsOn": "prep"}]}"#,
            )
            .tasks,
        );
        let order = execution_order(&all, 2).unwrap();
        assert_eq!(order, [1, 2]);
    }
}
