//! Reserve bounded resources without depending on a renamed atomic update API.
use std::sync::atomic::{AtomicUsize, Ordering};

/// Add `amount` only when the resulting count fits `limit`, even under contention.
pub fn try_reserve(count: &AtomicUsize, amount: usize, limit: usize) -> bool {
    let mut current = count.load(Ordering::Acquire);
    loop {
        let Some(next) = current.checked_add(amount).filter(|next| *next <= limit) else {
            return false;
        };
        match count.compare_exchange_weak(current, next, Ordering::AcqRel, Ordering::Acquire) {
            Ok(_) => return true,
            Err(actual) => current = actual,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Barrier;

    #[test]
    fn concurrent_reservations_cannot_exceed_the_limit() {
        let count = AtomicUsize::new(0);
        let ready = Barrier::new(32);
        std::thread::scope(|scope| {
            let tasks: Vec<_> = (0..32)
                .map(|_| {
                    scope.spawn(|| {
                        ready.wait();
                        try_reserve(&count, 3, 31)
                    })
                })
                .collect();
            let admitted = tasks
                .into_iter()
                .map(|task| task.join().unwrap())
                .filter(|reserved| *reserved)
                .count();
            assert_eq!(admitted, 10);
        });
        assert_eq!(count.load(Ordering::Acquire), 30);
        count.fetch_sub(6, Ordering::AcqRel);
        assert!(try_reserve(&count, 6, 31));
        assert!(!try_reserve(&count, usize::MAX, usize::MAX));
        assert_eq!(count.load(Ordering::Acquire), 30);
    }
}
